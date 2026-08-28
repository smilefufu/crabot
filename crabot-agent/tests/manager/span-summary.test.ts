import { describe, expect, it } from 'vitest'
import { summarizeSpanInput, summarizeSpanOutput } from '../../src/manager/span-summary.js'

describe('summarizeSpanInput', () => {
  it('名单内长文本字段截断补省略号，标识符字段无条件全保，产物恒为合法 JSON', () => {
    const summary = summarizeSpanInput({
      text: '很长的消息'.repeat(500),
      worker_id: 'w-d876c9fe-c44a-40dc-9eb9-73b723b9d977',
      immediate_redirect: false,
    })
    const parsed = JSON.parse(summary) as Record<string, unknown>
    expect(parsed.worker_id).toBe('w-d876c9fe-c44a-40dc-9eb9-73b723b9d977')
    expect(parsed.immediate_redirect).toBe(false)
    expect(typeof parsed.text).toBe('string')
    expect(parsed.text).toMatch(/…$/)
    expect((parsed.text as string).length).toBeLessThanOrEqual(1025)
  })

  it('名单外字段即使超长也不截断（宁多不坏，避免破坏未知字段结构）', () => {
    const longTitle = '长'.repeat(2000)
    const parsed = JSON.parse(summarizeSpanInput({ title: longTitle })) as Record<string, unknown>
    expect(parsed.title).toBe(longTitle)
  })

  it('未超限的名单内字段原样保留', () => {
    const parsed = JSON.parse(summarizeSpanInput({ text: '短消息', prompt: '短任务' })) as Record<string, unknown>
    expect(parsed.text).toBe('短消息')
    expect(parsed.prompt).toBe('短任务')
  })

  it('非对象输入退化为整段截断', () => {
    expect(summarizeSpanInput('纯文本入参'.repeat(1000))).toMatch(/…$/)
    expect(JSON.parse(summarizeSpanInput({ text: 'x' }))).toEqual({ text: 'x' })
  })
})

describe('summarizeSpanOutput', () => {
  it('回执带时间戳前缀时：前缀原样保留，JSON 部分字段级截断', () => {
    const output = `[18:30:54]\n${JSON.stringify({ status: 'delivered', delivery_id: 'd-1', worker_id: 'w-full', text: '长'.repeat(2000) })}`
    const summarized = summarizeSpanOutput(output)
    expect(summarized.startsWith('[18:30:54]\n')).toBe(true)
    const jsonPart = JSON.parse(summarized.slice('[18:30:54]\n'.length)) as Record<string, unknown>
    expect(jsonPart.worker_id).toBe('w-full')
    expect(jsonPart.status).toBe('delivered')
    expect(jsonPart.text).toMatch(/…$/)
  })

  it('无前缀的整体 JSON 同样处理', () => {
    const parsed = JSON.parse(summarizeSpanOutput(JSON.stringify({ status: 'spawned', worker_id: 'w-1', prompt: '长'.repeat(2000) }))) as Record<string, unknown>
    expect(parsed.worker_id).toBe('w-1')
    expect(parsed.prompt).toMatch(/…$/)
  })

  it('纯文本错误信息整段截断（4096 上限）', () => {
    const error = 'spawn_worker 失败: invalid workspace: ...'.repeat(200)
    const summarized = summarizeSpanOutput(error)
    expect(summarized.length).toBeLessThanOrEqual(4097)
    expect(summarized).toMatch(/…$/)
  })

  it('残缺 JSON（历史硬截形态）不做二次破坏，整段截断兜底', () => {
    const broken = '[18:30:54]\n{"status":"delivered","worker_id":"w-d876c9fe-c44a-4…'
    expect(summarizeSpanOutput(broken)).toBe(broken)
  })

  it('未超限的短回执原样返回', () => {
    const receipt = '[18:30:54]\n{"status":"delivered","worker_id":"w-full"}'
    expect(summarizeSpanOutput(receipt)).toBe(receipt)
  })
})
