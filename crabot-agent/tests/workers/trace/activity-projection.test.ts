import { describe, expect, it } from 'vitest'
import { projectWorkerActivity } from '../../../src/workers/trace/activity-projection.js'
import type { NormalizedTraceEvent } from '../../../src/workers/types.js'

const events: NormalizedTraceEvent[] = [
  { ts: '2026-08-20T00:00:00.000Z', kind: 'lifecycle', summary: 'state_changed', source: 'harness' },
  { ts: '2026-08-20T00:00:01.000Z', kind: 'message', role: 'user', summary: '请检查', source: 'native' },
  { ts: '2026-08-20T00:00:02.000Z', kind: 'tool_call', role: 'assistant', summary: 'read()', source: 'native' },
  { ts: '2026-08-20T00:00:03.000Z', kind: 'tool_result', summary: 'ok', source: 'native' },
  { ts: '2026-08-20T00:00:04.000Z', kind: 'message', role: 'assistant', summary: '检查完成', source: 'native' },
  { ts: '2026-08-20T00:00:05.000Z', kind: 'thinking', role: 'assistant', summary: 'internal', source: 'native' },
]

describe('projectWorkerActivity', () => {
  it('assistant view only returns native assistant text', () => {
    const result = projectWorkerActivity(events, 'assistant', { worker_id: 'w-1', incarnation_id: 'inc-1' })
    expect(result).toMatchObject([{
      worker_id: 'w-1',
      incarnation_id: 'inc-1',
      kind: 'assistant_text',
      summary: '检查完成',
      text: '检查完成',
    }])
  })

  it('all view adds tool calls/results but still excludes Harness lifecycle and non-assistant content', () => {
    expect(projectWorkerActivity(events, 'all', { worker_id: 'w-1', incarnation_id: 'inc-1' }).map((event) => event.kind)).toEqual([
      'tool_call', 'tool_result', 'assistant_text',
    ])
  })
})
