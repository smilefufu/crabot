import { describe, it, expect } from 'vitest'
import { extractWorkerCompletion, pageWorkerTurn } from '../../../src/workers/harness/worker-turn-result.js'
import type { WorkerTurn } from '../../../src/workers/harness/worker-turn-store.js'

const turn: WorkerTurn = {
  turn_id: 'turn-1', worker_id: 'worker-1', manager_key: 'wechat::one', incarnation_id: 'inc-1', impl: 'builtin', seq: 1,
  session_ref: 'session', activity_from: '10', activity_through: '20', completed_at: '2026-09-15T00:00:00Z',
  completion_source: 'builtin_end_turn', disposition: { status: 'pending' },
}

describe('完成回合正文与有界分页', () => {
  it.each(['result', 'activity'] as const)('%s 中文、emoji、JSON 转义和超长单行逐页无损拼接', (view) => {
    const content = ('中文😀"\\\n\t' + '\u0001').repeat(24_000) + '最终结论不能丢'
    const body = { source: view === 'result' ? 'completion_summary' as const : 'activity' as const, content }
    let cursor: string | undefined
    let combined = ''
    let pages = 0
    do {
      const page = pageWorkerTurn({ worker_id: turn.worker_id, view, cursor }, { ...turn, completion_result: { source: 'completion_summary', content } }, body)
      const serialized = JSON.stringify(page)
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(64 * 1024)
      expect(JSON.parse(serialized).content).toBe(page.content)
      expect(page.turn).not.toHaveProperty('completion_result')
      expect(page.content).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(page.content).not.toMatch(/^[\uDC00-\uDFFF]/)
      combined += page.content
      cursor = page.next_cursor ?? undefined
      expect(++pages).toBeLessThan(100)
    } while (cursor)
    expect(pages).toBeGreaterThan(1)
    expect(combined).toBe(content)
  })

  it('游标拒绝跨 Worker、turn、view、非法位置和来源变化', () => {
    const body = { source: 'assistant_text' as const, content: '😀'.repeat(30_000) }
    const cursor = pageWorkerTurn({ worker_id: turn.worker_id }, turn, body).next_cursor!
    for (const params of [
      { worker_id: 'other', cursor }, { worker_id: turn.worker_id, turn_id: 'other', cursor },
      { worker_id: turn.worker_id, view: 'activity' as const, cursor }, { worker_id: turn.worker_id, cursor: '$bad' },
    ]) expect(() => pageWorkerTurn(params, turn, body)).toThrow('cursor')
    expect(() => pageWorkerTurn({ worker_id: turn.worker_id, cursor }, turn, { ...body, content: body.content + 'changed' })).toThrow('source changed')
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    for (const offset of [-1, 1, 900_000, 1.5]) {
      const bad = Buffer.from(JSON.stringify({ ...decoded, offset })).toString('base64url')
      expect(() => pageWorkerTurn({ worker_id: turn.worker_id, cursor: bad }, turn, body)).toThrow()
    }
  })

  it('实际 summary 优先，三类执行器正文均保留，缺少正文明确标 preview', () => {
    const base = { ts: '', kind: 'message' as const, role: 'assistant' as const, summary: '截短预览' }
    expect(extractWorkerCompletion([base], '真实 summary')).toEqual({ source: 'completion_summary', content: '真实 summary' })
    for (const detail of [
      { content: '完整正文' }, { text: '完整正文' },
      { content: [{ type: 'text', text: '完整' }, { type: 'text', text: '正文' }] },
      { content: [{ type: 'output_text', text: '完整正文' }] },
    ]) expect(extractWorkerCompletion([{ ...base, detail }])).toEqual({ source: 'assistant_text', content: '完整正文' })
    expect(extractWorkerCompletion([base])).toMatchObject({ source: 'preview', content: '截短预览', unavailable_reason: expect.any(String) })
    expect(extractWorkerCompletion([])).toMatchObject({ source: 'unavailable', content: '' })
  })

  it('Git 列表挤占预算时仅缩减展示，保留截断标记和持久记录', () => {
    const gitTurn: WorkerTurn = { ...turn, workspace_git: {
      current: { workspace_root: '/workspace', captured_at: '', state: {
        status: 'repository', repository_root: '/workspace', scope: 'repository', linked_worktree: false,
        workspace_ignored: false, branch: 'main', head: 'a', dirty: true, change_count: 1000, unmerged_count: 0,
        changes: Array.from({ length: 1000 }, () => ({ path: 'long'.repeat(100), index_status: 'M', worktree_status: ' ' })), changes_truncated: false,
      } }, comparison: 'advanced', commits: Array.from({ length: 1000 }, () => 'a'.repeat(100)), commits_truncated: false,
    } }
    const page = pageWorkerTurn({ worker_id: turn.worker_id }, gitTurn, { source: 'completion_summary', content: '完成' })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024)
    expect(page.turn?.workspace_git?.current.state).toMatchObject({ changes_truncated: true, change_count: 1000 })
    expect(page.turn?.workspace_git?.commits_truncated).toBe(true)
    expect(gitTurn.workspace_git?.commits).toHaveLength(1000)
  })
})
