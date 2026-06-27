import { describe, it, expect } from 'vitest'
import { formatSubAgentNotification, type SubAgentExitInfo } from '../../src/agent/agent-handler'

function makeInfo(overrides: Partial<SubAgentExitInfo> = {}): SubAgentExitInfo {
  return {
    entity_id: 'agent_abc123',
    task_description: 'do the thing',
    status: 'completed',
    runtime_ms: 1234,
    result_file: '/data/agent/bg/agent_abc123.result',
    finalText: 'short answer',
    ...overrides,
  }
}

describe('formatSubAgentNotification', () => {
  it('小结果：内联完整预览、不标 truncated、不提示读全文', () => {
    const n = formatSubAgentNotification(makeInfo({ finalText: 'short answer' }))
    expect(n).toContain('<status>completed</status>')
    expect(n).toContain('<result_preview>\nshort answer\n</result_preview>')
    expect(n).not.toContain('truncated="true"')
    expect(n).not.toContain('结果已截断')
    // output_file 始终附上
    expect(n).toContain('<output_file>/data/agent/bg/agent_abc123.result</output_file>')
  })

  it('大结果：预览截断 + 标 truncated + 提示用 get_subagent_output 读全文', () => {
    const big = 'x'.repeat(5000)
    const n = formatSubAgentNotification(makeInfo({ finalText: big }))
    expect(n).toContain('truncated="true"')
    // 预览被截断到 2000 字符（不含完整 5000）
    const m = n.match(/<result_preview truncated="true">\n(x+)\n<\/result_preview>/)
    expect(m).not.toBeNull()
    expect(m![1].length).toBe(2000)
    expect(n).toContain('结果已截断')
    expect(n).toContain('get_subagent_output("agent_abc123")')
  })

  it('失败：给 error + 失败 guidance，不内联预览', () => {
    const n = formatSubAgentNotification(
      makeInfo({ status: 'failed', error: 'HTTP 500 upstream', finalText: '' }),
    )
    expect(n).toContain('<status>failed</status>')
    expect(n).toContain('<error>HTTP 500 upstream</error>')
    expect(n).toContain('子任务失败')
    expect(n).not.toContain('<result_preview')
  })

  it('成功但无输出文本：不产出空 result_preview', () => {
    const n = formatSubAgentNotification(makeInfo({ finalText: '', result_file: null }))
    expect(n).not.toContain('<result_preview')
    expect(n).not.toContain('<output_file>')
  })
})
