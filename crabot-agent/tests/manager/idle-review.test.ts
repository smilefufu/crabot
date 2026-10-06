import { describe, expect, it } from 'vitest'
import { IdleReviewRead, boardReviewFingerprint } from '../../src/manager/idle-review.js'
import type { ManagerWorkboard } from '../../src/manager/workboard-store.js'
import type { EngineToolLifecycleEvent } from '../../src/engine/types.js'

const board: ManagerWorkboard = { manager_key: 'bot::session', archive: [], objectives: ['b', 'a'].map(id => ({
  objective_id: id, title: id, completion_criteria: ['交付'], updated_at: '2026-10-01T00:00:00Z', work_items: [],
})) }
function event(objectives = board.objectives, input = {}, isError = false, name = 'inspect_workboard'):
  Extract<EngineToolLifecycleEvent, { type: 'tool_finished' }> {
  return { type: 'tool_finished', name, input, isError, responseId: 'response', callId: 'call', toolUseId: 'tool',
    turnNumber: 1, startedAtMs: 0, endedAtMs: 1, durationMs: 1,
    output: `[08:00:00]\n${JSON.stringify({ view: 'active', objectives })}` }
}

describe('自省复用资格', () => {
  it('必须完整成功查板，可跨页，排序与更新时间不制造变化', () => {
    const read = new IdleReviewRead(board)
    expect(read.complete).toBe(false)
    read.record(event([board.objectives[0]], { page: 1 }), true)
    expect(read.complete).toBe(false)
    read.record(event([board.objectives[1]], { page: 2 }), true)
    expect(read.complete).toBe(true)
    const reordered = { ...board, objectives: [...board.objectives].reverse().map(item => ({ ...item, updated_at: 'later' })) }
    expect(boardReviewFingerprint(reordered)).toBe(boardReviewFingerprint(board))
    expect(boardReviewFingerprint({ ...board, objectives: [] })).not.toBe(boardReviewFingerprint(board))
  })
  it.each(['error', 'write', 'filtered', 'archive', 'partial', 'wrong-content'] as const)('%s不能建立基线', mode => {
    const read = new IdleReviewRead(board)
    read.record(event(mode === 'partial' ? [board.objectives[0]]
      : mode === 'wrong-content' ? board.objectives.map(item => ({ ...item, title: '旧内容' })) : board.objectives,
    mode === 'filtered' ? { query: 'a' } : mode === 'archive' ? { view: 'archive' } : {}, mode === 'error'), mode !== 'write')
    expect(read.complete).toBe(false)
  })
  it('查板之后的失败或业务动作仍禁止复用', () => {
    for (const isError of [true, false]) {
      const read = new IdleReviewRead(board)
      read.record(event(), true)
      read.record(event([], {}, isError, 'send_message'), false)
      expect(read.complete).toBe(false)
    }
  })
})
