import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMemoryV2RestRouter } from './memory-v2-rest.js'

describe('memory-v2 REST entries', () => {
  let rpc: { call: ReturnType<typeof vi.fn> }
  let router: ReturnType<typeof createMemoryV2RestRouter>
  const moduleId = 'admin-test'

  beforeEach(() => {
    rpc = { call: vi.fn() }
    router = createMemoryV2RestRouter({
      rpcClient: rpc as any,
      moduleId,
      getMemoryPort: async () => 19999,
    })
  })

  it('GET /api/memory/v2/entries → list_entries with type/status filters', async () => {
    rpc.call.mockResolvedValue({ items: [{ id: 'mem-l-1', type: 'fact', status: 'confirmed' }] })
    const res = await router.dispatch('GET', '/api/memory/v2/entries?type=fact&status=confirmed&limit=20')
    expect(rpc.call).toHaveBeenCalledWith(
      19999, 'list_entries',
      { type: 'fact', status: 'confirmed', limit: 20 },
      moduleId,
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [{ id: 'mem-l-1', type: 'fact', status: 'confirmed' }] })
  })

  it('GET /api/memory/v2/entries/:id → get_memory with include=full', async () => {
    rpc.call.mockResolvedValue({ id: 'mem-l-1', body: 'foo', frontmatter: {} })
    const res = await router.dispatch('GET', '/api/memory/v2/entries/mem-l-1?include=full')
    expect(rpc.call).toHaveBeenCalledWith(
      19999, 'get_memory', { id: 'mem-l-1', include: 'full' }, moduleId,
    )
    expect(res.status).toBe(200)
  })

  it('POST /api/memory/v2/entries → write_long_term (status=confirmed, author=user)', async () => {
    rpc.call.mockResolvedValue({ id: 'mem-l-new', status: 'ok' })
    const body = JSON.stringify({
      type: 'fact', brief: 'test', content: 'body',
      source_ref: { type: 'manual' }, source_trust: 5, content_confidence: 5,
      importance_factors: { proximity: 0.5, surprisal: 0.5, entity_priority: 0.5, unambiguity: 0.5 },
      event_time: '2026-04-23T00:00:00Z',
      entities: [], tags: [],
    })
    const res = await router.dispatch('POST', '/api/memory/v2/entries', body)
    expect(rpc.call).toHaveBeenCalledWith(
      19999, 'write_long_term',
      expect.objectContaining({ type: 'fact', author: 'user', status: 'confirmed', brief: 'test' }),
      moduleId,
    )
    expect(res.status).toBe(201)
  })

  it('PATCH /api/memory/v2/entries/:id → update_long_term', async () => {
    rpc.call.mockResolvedValue({ id: 'mem-l-1', version: 2, status: 'ok' })
    const res = await router.dispatch('PATCH', '/api/memory/v2/entries/mem-l-1', JSON.stringify({ patch: { brief: 'new' } }))
    expect(rpc.call).toHaveBeenCalledWith(
      19999, 'update_long_term', { id: 'mem-l-1', patch: { brief: 'new' } }, moduleId,
    )
    expect(res.status).toBe(200)
  })

  it('DELETE /api/memory/v2/entries/:id → delete_memory (soft)', async () => {
    rpc.call.mockResolvedValue({ status: 'ok' })
    const res = await router.dispatch('DELETE', '/api/memory/v2/entries/mem-l-1')
    expect(rpc.call).toHaveBeenCalledWith(
      19999, 'delete_memory', { id: 'mem-l-1' }, moduleId,
    )
    expect(res.status).toBe(204)
  })

  it('POST /api/memory/v2/entries/:id/restore → restore_memory', async () => {
    rpc.call.mockResolvedValue({ id: 'mem-l-1', status: 'ok' })
    const res = await router.dispatch('POST', '/api/memory/v2/entries/mem-l-1/restore')
    expect(rpc.call).toHaveBeenCalledWith(
      19999, 'restore_memory', { id: 'mem-l-1' }, moduleId,
    )
    expect(res.status).toBe(200)
  })

  it('GET /api/memory/v2/entries?type=invalid → 400 with reason (no RPC dispatched)', async () => {
    const res = await router.dispatch('GET', '/api/memory/v2/entries?type=invalid_type')
    expect(res.status).toBe(400)
    const body = res.body as { error: string; reason: string }
    expect(body.error).toBe('invalid_type')
    expect(body.reason).toMatch(/fact\|lesson\|concept/)
    expect(body.reason).toContain('invalid_type')
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('GET /api/memory/v2/entries?status=invalid → 400 with reason (no RPC dispatched)', async () => {
    const res = await router.dispatch('GET', '/api/memory/v2/entries?status=garbage')
    expect(res.status).toBe(400)
    const body = res.body as { error: string; reason: string }
    expect(body.error).toBe('invalid_status')
    expect(body.reason).toMatch(/inbox\|confirmed\|trash/)
    expect(body.reason).toContain('garbage')
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('GET /api/memory/v2/entries?type=invalid&status=invalid → 400 fails fast on first invalid param', async () => {
    const res = await router.dispatch('GET', '/api/memory/v2/entries?type=foo&status=bar')
    expect(res.status).toBe(400)
    const body = res.body as { error: string }
    // type 先校验，所以应该报 invalid_type
    expect(body.error).toBe('invalid_type')
    expect(rpc.call).not.toHaveBeenCalled()
  })
})

describe('memory-v2 REST mode + maintenance + observation', () => {
  let rpc: { call: ReturnType<typeof vi.fn> }
  let router: ReturnType<typeof createMemoryV2RestRouter>
  const moduleId = 'admin-test'

  beforeEach(() => {
    rpc = { call: vi.fn() }
    router = createMemoryV2RestRouter({ rpcClient: rpc as any, moduleId, getMemoryPort: async () => 19999 })
  })

  it('GET /api/memory/v2/evolution-mode', async () => {
    rpc.call.mockResolvedValue({ mode: 'balanced', last_changed_at: '2026-04-23T00:00:00Z', reason: 'default' })
    const res = await router.dispatch('GET', '/api/memory/v2/evolution-mode')
    expect(rpc.call).toHaveBeenCalledWith(19999, 'get_evolution_mode', {}, moduleId)
    expect(res.status).toBe(200)
    expect((res.body as any).mode).toBe('balanced')
  })

  it('PUT /api/memory/v2/evolution-mode', async () => {
    rpc.call.mockResolvedValue({ status: 'ok' })
    const res = await router.dispatch(
      'PUT', '/api/memory/v2/evolution-mode',
      JSON.stringify({ mode: 'innovate', reason: 'low error rate' }),
    )
    expect(rpc.call).toHaveBeenCalledWith(
      19999, 'set_evolution_mode',
      { mode: 'innovate', reason: 'low error rate' },
      moduleId,
    )
    expect(res.status).toBe(200)
  })

  it('GET /api/memory/v2/observation-pending', async () => {
    rpc.call.mockResolvedValue({ items: [{ id: 'mem-l-1', validation_outcome: 'pending' }] })
    const res = await router.dispatch('GET', '/api/memory/v2/observation-pending')
    expect(rpc.call).toHaveBeenCalledWith(19999, 'get_observation_pending', {}, moduleId)
    expect(res.status).toBe(200)
  })

  it('POST /api/memory/v2/maintenance/run with scope', async () => {
    rpc.call.mockResolvedValue({ report: { observation_check: { passed: 1 }, completed_at: 't' } })
    const res = await router.dispatch(
      'POST', '/api/memory/v2/maintenance/run',
      JSON.stringify({ scope: 'observation_check' }),
    )
    expect(rpc.call).toHaveBeenCalledWith(
      19999, 'run_maintenance', { scope: 'observation_check' }, moduleId,
    )
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ran: ['observation_check'] })
  })

  it('POST /api/memory/v2/maintenance/run defaults to scope=all', async () => {
    rpc.call.mockResolvedValue({
      report: {
        observation_check: { passed: 0 },
        stale_aging: { marked: 0 },
        trash_cleanup: { deleted: 0 },
        completed_at: 't',
      },
    })
    const res = await router.dispatch('POST', '/api/memory/v2/maintenance/run', '{}')
    expect(rpc.call).toHaveBeenCalledWith(
      19999, 'run_maintenance', { scope: 'all' }, moduleId,
    )
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ran: ['observation_check', 'stale_aging', 'trash_cleanup'],
    })
  })
})

describe('memory-v2-rest — new observation/keyword routes', () => {
  it('POST /api/memory/v2/entries/:id/mark-observation-pass routes to mark_observation_pass', async () => {
    const calls: Array<{ port: number; method: string; params: unknown }> = []
    const rpcClient = { call: async (port: number, method: string, params: unknown) => { calls.push({ port, method, params }); return { id: 'mem-l-x', status: 'ok' } } }
    const router = createMemoryV2RestRouter({ rpcClient: rpcClient as never, moduleId: 'admin', getMemoryPort: async () => 4100 })
    const r = await router.dispatch('POST', '/api/memory/v2/entries/mem-l-x/mark-observation-pass', '{}')
    expect(r.status).toBe(200)
    expect(calls[0].method).toBe('mark_observation_pass')
    expect(calls[0].params).toEqual({ id: 'mem-l-x' })
  })

  it('POST /api/memory/v2/entries/:id/extend-observation routes with days param', async () => {
    const calls: Array<{ port: number; method: string; params: unknown }> = []
    const rpcClient = { call: async (port: number, method: string, params: unknown) => { calls.push({ port, method, params }); return { id: 'mem-l-x', new_window_days: 14 } } }
    const router = createMemoryV2RestRouter({ rpcClient: rpcClient as never, moduleId: 'admin', getMemoryPort: async () => 4100 })
    const r = await router.dispatch('POST', '/api/memory/v2/entries/mem-l-x/extend-observation', '{"days":7}')
    expect(r.status).toBe(200)
    expect(calls[0].method).toBe('extend_observation_window')
    expect(calls[0].params).toEqual({ id: 'mem-l-x', days: 7 })
  })

  it('POST /api/memory/v2/entries/search-keyword routes to keyword_search', async () => {
    const calls: Array<{ port: number; method: string; params: unknown }> = []
    const rpcClient = { call: async (port: number, method: string, params: unknown) => { calls.push({ port, method, params }); return { items: [] } } }
    const router = createMemoryV2RestRouter({ rpcClient: rpcClient as never, moduleId: 'admin', getMemoryPort: async () => 4100 })
    const r = await router.dispatch('POST', '/api/memory/v2/entries/search-keyword', '{"query":"macOS","type":"fact"}')
    expect(r.status).toBe(200)
    expect(calls[0].method).toBe('keyword_search')
    expect(calls[0].params).toEqual({ query: 'macOS', type: 'fact' })
  })

  it('GET /api/memory/v2/proposals returns 404 (route removed)', async () => {
    const rpcClient = { call: async () => ({}) }
    const router = createMemoryV2RestRouter({ rpcClient: rpcClient as never, moduleId: 'admin', getMemoryPort: async () => 4100 })
    const r = await router.dispatch('GET', '/api/memory/v2/proposals')
    expect(r.status).toBe(404)
  })
})
