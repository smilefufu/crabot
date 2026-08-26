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
  ['w-1', { worker_id: 'w-1', title: '部署 Minecraft', status: 'waiting_input' }],
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
    expect(joined.worker_ref).toEqual({ worker_id: 'w-1', title: '部署 Minecraft', state_to: 'waiting_input' })

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
    }), facts))).toBe('部署 Minecraft：等输入')
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

  it('无投影数据时不添加空字段，保留原 trace', () => {
    const original = trace()
    const result = projectManagerEpisode(original, facts)
    expect(result).toEqual(original)
    expect(result).not.toHaveProperty('reply_excerpt')
  })
})
