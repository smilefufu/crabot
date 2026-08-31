import { describe, expect, it } from 'vitest'
import { extractStringField, managerActivitySummary, projectManagerEpisode, withCausalParent, type EpisodeWorkerFact } from '../../src/manager/episode-projection.js'
import type { ManagerEpisodeTrace, ManagerEpisodeSpan } from '../../src/manager/trace-types.js'

const tool = (name: string, input: string, output = '{}'): ManagerEpisodeSpan => ({
  span_id: `span-${name}-${Math.random()}`,
  type: 'tool_call',
  started_at: '2026-08-17T00:00:00.000Z',
  status: 'completed',
  details: { name, input_summary: input, output_summary: output },
})

function trace(over: Partial<ManagerEpisodeTrace> = {}): ManagerEpisodeTrace {
  return {
    trace_id: 'ep-1',
    manager_key: 'test::session',
    started_at: '2026-08-17T00:00:00.000Z',
    status: 'completed',
    trigger: { type: 'human_message', summary: '人类消息 x1' },
    spans: [],
    spawned_worker_ids: [],
    ...over,
  }
}

const facts = new Map<string, EpisodeWorkerFact>([
  ['w-1', { worker_id: 'w-1', title: '部署 Minecraft', status: 'halted' }],
])

describe('projectManagerEpisode', () => {
  it('提取回复、派活/跟进/取消/请求中断，并 join worker 标题', () => {
    const result = projectManagerEpisode(trace({ spans: [
      tool('send_message', JSON.stringify({ content: '已经开始部署，会在完成后汇报。' })),
      tool('spawn_worker', JSON.stringify({ title: '部署 Minecraft', prompt: '很长任务' }), JSON.stringify({ worker_id: 'w-1' })),
      tool('send_to_worker', JSON.stringify({ worker_id: 'w-1', text: '继续' })),
      tool('kill_worker', JSON.stringify({ worker_id: 'w-1' })),
      tool('request_worker_interrupt', JSON.stringify({ worker_id: 'w-1' })),
    ] }), facts)
    expect(result.reply_excerpt).toBe('已经开始部署，会在完成后汇报。')
    expect(result.actions).toEqual([
      { kind: 'spawn_worker', label: '派活：部署 Minecraft', worker_id: 'w-1' },
      { kind: 'send_to_worker', label: '跟进：部署 Minecraft', worker_id: 'w-1' },
      { kind: 'cancel_worker', label: '取消：部署 Minecraft', worker_id: 'w-1' },
      { kind: 'other', label: '请求中断：部署 Minecraft', worker_id: 'w-1' },
    ])
  })

  it('每日反思固定摘要也投影为人类回复', () => {
    const result = projectManagerEpisode(trace({ spans: [
      tool('send_daily_reflection_summary', JSON.stringify({ content: '今日已完成记忆整理。' })),
    ] }), facts)
    expect(result.reply_excerpt).toBe('今日已完成记忆整理。')
  })

  it('worker_event 从 source join 标题和当前状态；缺台账安全降级 id', () => {
    const joined = projectManagerEpisode(trace({
      trigger: { type: 'worker_event', summary: 'worker 事件:state_changed (w-1)', source: 'worker:w-1' },
    }), facts)
    expect(joined.worker_ref).toEqual({ worker_id: 'w-1', title: '部署 Minecraft', state_to: 'halted' })

    const missing = projectManagerEpisode(trace({
      trigger: { type: 'worker_event', summary: 'worker 事件:state_changed (w-missing)' },
    }), facts)
    expect(missing.worker_ref).toEqual({ worker_id: 'w-missing' })
  })

  it('畸形/truncated JSON 不抛；可从前缀提取 string token', () => {
    const truncated = '{"content":"这是一段仍可提取的回复","other":"unterminated…'
    expect(extractStringField(truncated, 'content')).toBe('这是一段仍可提取的回复')
    expect(() => projectManagerEpisode(trace({ spans: [
      tool('send_message', truncated),
      { ...tool('spawn_worker', 'not-json', 'not-json'), details: null },
    ] }), facts)).not.toThrow()
  })

  it('跨页 worker_event 可携带最小 spawn 父 episode', () => {
    const parent = projectManagerEpisode(trace({
      trace_id: 'ep-parent',
      trigger: { type: 'human_message', summary: '人类消息 x1：开始部署' },
      spans: [tool('spawn_worker', JSON.stringify({ title: '部署 Minecraft' }), JSON.stringify({ worker_id: 'w-1' }))],
    }), facts)
    const child = projectManagerEpisode(trace({
      trace_id: 'ep-child',
      trigger: { type: 'worker_event', summary: 'state', source: 'worker:w-1' },
    }), facts)
    expect(withCausalParent(child, parent).causal_parent).toMatchObject({
      trace_id: 'ep-parent',
      trigger: { summary: '人类消息 x1：开始部署' },
      actions: [{ worker_id: 'w-1' }],
    })
  })

  it('Manager 列表最近活动摘要是人话', () => {
    expect(managerActivitySummary(projectManagerEpisode(trace({
      trigger: { type: 'human_message', summary: '人类消息 x1：V6 部署好了吗' },
    }), facts))).toBe('你：V6 部署好了吗')
    expect(managerActivitySummary(projectManagerEpisode(trace({
      trigger: { type: 'worker_event', summary: 'worker 事件:state_changed (w-1)', source: 'worker:w-1' },
    }), facts))).toBe('部署 Minecraft：已停止待处置')
  })

  it('目标 string 自身被 300 字截断时仍返回可读前缀', () => {
    const full = JSON.stringify({ channel_id: 'admin-web', session_id: 'admin-chat', content: '长回复'.repeat(200) })
    const truncated = `${full.slice(0, 300)}…`
    const extracted = extractStringField(truncated, 'content')
    expect(extracted).toBeDefined()
    expect(extracted).toMatch(/^长回复长回复/)
    expect(extracted?.endsWith('…')).toBe(true)
    const projected = projectManagerEpisode(trace({ spans: [tool('send_message', truncated)] }), facts)
    expect(projected.reply_excerpt).toMatch(/^长回复/)
  })

  it('非 string 目标不误取后一个字段', () => {
    expect(extractStringField('{"content":123,"other":"xyz', 'content')).toBeUndefined()
  })

  // 存量数据形态：input_summary 被 300 字符硬截，worker_id 前缀残缺以…结尾；
  // 同一 span 的 output 回执携带完整真 ID（生产 trace feece070 实测）。
  const truncatedWorkerInput = `{"text":"${'继续截图分析任务，请直接只读打开截图完成分析并汇报。'.repeat(8)}","worker_id":"w-d876c9fe-c44a-4…`
  const receiptWithFullId = `[18:30:54]\n${JSON.stringify({ status: 'delivered', delivery_id: 'd-1', worker_id: 'w-full' })}`
  const factsWithFull = new Map<string, EpisodeWorkerFact>([
    ...facts,
    ['w-full', { worker_id: 'w-full', title: '截图分析', status: 'running' }],
  ])

  it('存量截断 input 的前缀 ID 不可信：优先从 output 回执恢复完整 worker_id', () => {
    const result = projectManagerEpisode(trace({ spans: [
      tool('send_to_worker', truncatedWorkerInput, receiptWithFullId),
    ] }), factsWithFull)
    expect(result.actions).toEqual([
      { kind: 'send_to_worker', label: '跟进：截图分析', worker_id: 'w-full' },
    ])
  })

  it('input 与 output 都取不到有效 ID 时不设置 worker_id 字段（不产生死链）', () => {
    const result = projectManagerEpisode(trace({ spans: [
      tool('send_to_worker', truncatedWorkerInput, '[18:30:54]\n{"status":"failed","error":"boom"}'),
    ] }), factsWithFull)
    expect(result.actions).toEqual([{ kind: 'send_to_worker', label: '跟进：worker' }])
  })

  it('spawn_worker 回执被截断时不产出假 worker_id', () => {
    const result = projectManagerEpisode(trace({ spans: [
      tool('spawn_worker', '{"title":"部署 Minecraft","prompt":"很长任务"}', '[17:52:49]\n{"status":"spawned","worker_id":"w-trunc…'),
    ] }), facts)
    expect(result.actions).toEqual([{ kind: 'spawn_worker', label: '派活：部署 Minecraft' }])
  })

  it('kill_worker / request_worker_interrupt 的截断 ID 同样丢弃并从 output 兜底', () => {
    const result = projectManagerEpisode(trace({ spans: [
      tool('kill_worker', '{"worker_id":"w-d876c9fe-c44a-4…', '[17:31:00]\n{"status":"accepted","worker_id":"w-full"}'),
      tool('request_worker_interrupt', '{"worker_id":"w-d876c9fe-c44a-4…', '[17:32:03]\n{"operation":{"worker_id":"w-full","kind":"interrupt"}}'),
    ] }), factsWithFull)
    expect(result.actions).toEqual([
      { kind: 'cancel_worker', label: '取消：截图分析', worker_id: 'w-full' },
      { kind: 'other', label: '请求中断：截图分析', worker_id: 'w-full' },
    ])
  })

  it('无投影数据时不添加空字段，保留原 trace', () => {
    const original = trace()
    const result = projectManagerEpisode(original, facts)
    expect(result).toEqual(original)
    expect(result).not.toHaveProperty('reply_excerpt')
  })
})
