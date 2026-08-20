import { describe, expect, it, vi } from 'vitest'
import { buildWorkerTools } from '../../src/manager/tools/worker-tools.js'
import type { LedgerWorker, ManagerKey } from '../../src/workers/harness/ledger-types.js'

const A = 'wechat::a' as ManagerKey
const B = 'telegram::b' as ManagerKey
function worker(id: string, key: ManagerKey): LedgerWorker {
  return { worker_id: id, manager_key: key, task: { id, title: id, status: 'running', created_at: '2026-08-10T00:00:00.000Z' }, origin: { trigger_type: 'message' }, report_to: { channel_id: 'x', session_id: 'y' }, incarnations: [], updated_at: `2026-08-10T00:00:0${id === 'b' ? '2' : '1'}.000Z` }
}
function tools(master = false, valid = true) {
  const a = worker('a', A), b = worker('b', B)
  const harness = {
    findWorker: vi.fn(async (id: string) => id === 'a' ? { managerKey: A, worker: a } : id === 'b' ? { managerKey: B, worker: b } : undefined),
    listWorkers: vi.fn(async () => [a]), listAllWorkers: vi.fn(async () => [{ managerKey: A, worker: a }, { managerKey: B, worker: b }]),
    sendToWorker: vi.fn(), queryWorker: vi.fn(), killWorker: vi.fn(), getWorkerTerminal: vi.fn(), spawnWorker: vi.fn(),
  }
  const auth = master ? { kind: 'friend_master' as const, manager_key: A, friend_id: 'f', generation: 1 } : undefined
  return { harness, list: buildWorkerTools({ harness: harness as never, context: () => ({ managerKey: A, reportTo: { channel_id: 'wechat', session_id: 'a' } }), authorization: () => auth, validateMasterAuthorization: async () => valid }) }
}

describe('session worker authorization', () => {
  it('ordinary tool face has no list_all_workers; known external ID is uniformly denied before worker actions', async () => {
    const { harness, list } = tools(false)
    expect(list.map(t => t.name)).not.toContain('list_all_workers')
    for (const name of ['send_to_worker', 'query_worker', 'kill_worker', 'get_worker_terminal', 'get_worker_detail']) {
      const tool = list.find(t => t.name === name)!
      const result = await tool.call(name === 'query_worker' ? { worker_id: 'b', question: 'q' } : name === 'send_to_worker' ? { worker_id: 'b', text: 'x' } : { worker_id: 'b' })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('不存在或当前会话无权访问')
    }
    expect(harness.sendToWorker).not.toHaveBeenCalled(); expect(harness.queryWorker).not.toHaveBeenCalled(); expect(harness.killWorker).not.toHaveBeenCalled()
  })

  it('Master gets explicit global list with stable pagination and execution-time revocation rejects cross-session detail', async () => {
    const { list } = tools(true)
    const all = list.find(t => t.name === 'list_all_workers')!
    const page = await all.call({ page: 1, page_size: 1 })
    expect(page.isError).toBe(false)
    expect(JSON.parse(page.output)).toMatchObject({ items: [{ worker_id: 'b' }], pagination: { page: 1, page_size: 1, total_items: 2, total_pages: 2 } })
    const detail = list.find(t => t.name === 'get_worker_detail')!
    const old = await detail.call({ worker_id: 'b' })
    expect(old.isError).toBe(false)
    const revoked = buildWorkerTools({ harness: tools(true).harness as never, context: () => ({ managerKey: A, reportTo: { channel_id: 'wechat', session_id: 'a' } }), authorization: () => ({ kind: 'friend_master', manager_key: A, friend_id: 'f', generation: 1 }), validateMasterAuthorization: async () => false })
    expect((await revoked.find(t => t.name === 'get_worker_detail')!.call({ worker_id: 'b' })).isError).toBe(true)
  })

  it('captures Master generation once: an old privileged closure remains denied after regrant', async () => {
    const a = worker('a', A), b = worker('b', B)
    let generation = 1
    const harness = {
      findWorker: vi.fn(async (id: string) => id === 'b' ? { managerKey: B, worker: b } : { managerKey: A, worker: a }),
      listWorkers: vi.fn(async () => [a]), listAllWorkers: vi.fn(async () => [{ managerKey: A, worker: a }, { managerKey: B, worker: b }]),
      sendToWorker: vi.fn(), queryWorker: vi.fn(), killWorker: vi.fn(), getWorkerTerminal: vi.fn(), spawnWorker: vi.fn(),
    }
    const authorization = () => ({ kind: 'friend_master' as const, manager_key: A, friend_id: 'f', generation })
    const old = buildWorkerTools({ harness: harness as never, context: () => ({ managerKey: A, reportTo: { channel_id: 'wechat', session_id: 'a' } }), authorization, validateMasterAuthorization: async auth => auth.generation === generation })
    generation = 2 // downgrade/invalidate then same Friend regrant
    const oldAll = old.find(tool => tool.name === 'list_all_workers')!
    const oldDetail = old.find(tool => tool.name === 'get_worker_detail')!
    expect((await oldAll.call({})).isError).toBe(true)
    expect((await oldDetail.call({ worker_id: 'b' })).isError).toBe(true)
    expect(harness.listAllWorkers).not.toHaveBeenCalled()
  })

})
