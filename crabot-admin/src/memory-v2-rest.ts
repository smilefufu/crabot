export interface MemoryV2RestRouterDeps {
  rpcClient: { call: <P, R>(port: number, method: string, params: P, originModuleId: string) => Promise<R> }
  moduleId: string
  getMemoryPort: (moduleId?: string) => Promise<number>
}

export interface RestResponse {
  status: number
  body?: unknown
}

const VALID_TYPES = new Set(['fact', 'lesson', 'concept'])
const VALID_STATUSES = new Set(['inbox', 'confirmed', 'trash'])
const MAINTENANCE_TASKS = ['observation_check', 'stale_aging', 'trash_cleanup'] as const

export function createMemoryV2RestRouter(deps: MemoryV2RestRouterDeps) {
  const { rpcClient, moduleId, getMemoryPort } = deps

  function parseUrl(rawUrl: string): { pathname: string; query: URLSearchParams } {
    const u = new URL(rawUrl, 'http://localhost')
    return { pathname: u.pathname, query: u.searchParams }
  }

  async function dispatch(method: string, rawUrl: string, body?: string): Promise<RestResponse> {
    const { pathname, query } = parseUrl(rawUrl)
    const port = await getMemoryPort(query.get('module_id') ?? undefined)

    // GET /api/memory/v2/entries — list
    if (method === 'GET' && pathname === '/api/memory/v2/entries') {
      const params: Record<string, unknown> = {}
      const type_ = query.get('type')
      if (type_) {
        if (!VALID_TYPES.has(type_)) {
          return {
            status: 400,
            body: {
              error: 'invalid_type',
              reason: `type must be one of ${[...VALID_TYPES].join('|')}, got "${type_}"`,
            },
          }
        }
        params.type = type_
      }
      const status = query.get('status')
      if (status) {
        if (!VALID_STATUSES.has(status)) {
          return {
            status: 400,
            body: {
              error: 'invalid_status',
              reason: `status must be one of ${[...VALID_STATUSES].join('|')}, got "${status}"`,
            },
          }
        }
        params.status = status
      }
      const author = query.get('author')
      if (author) params.author = author
      const tagsRaw = query.get('tags')
      if (tagsRaw) params.tags = tagsRaw.split(',').filter(Boolean)
      const limit = query.get('limit')
      if (limit) {
        const n = parseInt(limit, 10)
        if (Number.isFinite(n)) params.limit = n
      }
      const offset = query.get('offset')
      if (offset) {
        const n = parseInt(offset, 10)
        if (Number.isFinite(n)) params.offset = n
      }
      const sort = query.get('sort')
      if (sort) params.sort = sort
      const result = await rpcClient.call(port, 'list_entries', params, moduleId)
      return { status: 200, body: result }
    }

    // POST /api/memory/v2/entries/:id/restore — must be checked before idMatch
    const restoreMatch = pathname.match(/^\/api\/memory\/v2\/entries\/([^/]+)\/restore$/)
    if (method === 'POST' && restoreMatch) {
      const id = restoreMatch[1]
      const result = await rpcClient.call(port, 'restore_memory', { id }, moduleId)
      return { status: 200, body: result }
    }

    // POST /api/memory/v2/entries/:id/mark-observation-pass — must be before idMatch
    const markPassMatch = pathname.match(/^\/api\/memory\/v2\/entries\/([^/]+)\/mark-observation-pass$/)
    if (method === 'POST' && markPassMatch) {
      const id = markPassMatch[1]
      const result = await rpcClient.call(port, 'mark_observation_pass', { id }, moduleId)
      return { status: 200, body: result }
    }

    // POST /api/memory/v2/entries/:id/extend-observation — must be before idMatch
    const extendMatch = pathname.match(/^\/api\/memory\/v2\/entries\/([^/]+)\/extend-observation$/)
    if (method === 'POST' && extendMatch) {
      const id = extendMatch[1]
      const parsed = body ? JSON.parse(body) : {}
      const days = typeof parsed.days === 'number' ? parsed.days : undefined
      const params: { id: string; days?: number } = { id }
      if (days !== undefined) params.days = days
      const result = await rpcClient.call(port, 'extend_observation_window', params, moduleId)
      return { status: 200, body: result }
    }

    // POST /api/memory/v2/entries/search-keyword — must be before idMatch
    if (method === 'POST' && pathname === '/api/memory/v2/entries/search-keyword') {
      const parsed = body ? JSON.parse(body) : {}
      const result = await rpcClient.call(port, 'keyword_search', parsed, moduleId)
      return { status: 200, body: result }
    }

    // GET /api/memory/v2/entries/:id/versions/:version — get archived version snapshot
    const versionMatch = pathname.match(/^\/api\/memory\/v2\/entries\/([^/]+)\/versions\/(\d+)$/)
    if (method === 'GET' && versionMatch) {
      const id = versionMatch[1]
      const version = parseInt(versionMatch[2], 10)
      const result = await rpcClient.call(port, 'get_entry_version', { id, version }, moduleId)
      return { status: 200, body: result }
    }

    const idMatch = pathname.match(/^\/api\/memory\/v2\/entries\/([^/]+)$/)

    // GET /api/memory/v2/entries/:id — get single
    if (method === 'GET' && idMatch) {
      const id = idMatch[1]
      const include = query.get('include') ?? 'brief'
      const result = await rpcClient.call(port, 'get_memory', { id, include }, moduleId)
      return { status: 200, body: result }
    }

    // POST /api/memory/v2/entries — create
    if (method === 'POST' && pathname === '/api/memory/v2/entries') {
      if (!body) return { status: 400, body: { error: 'body required' } }
      const parsed = JSON.parse(body)
      const params = { ...parsed, author: 'user', status: 'confirmed' }
      const result = await rpcClient.call(port, 'write_long_term', params, moduleId)
      return { status: 201, body: result }
    }

    // PATCH /api/memory/v2/entries/:id — update
    if (method === 'PATCH' && idMatch) {
      const id = idMatch[1]
      if (!body) return { status: 400, body: { error: 'body required' } }
      const parsed = JSON.parse(body)
      const result = await rpcClient.call(port, 'update_long_term', { id, ...parsed }, moduleId)
      return { status: 200, body: result }
    }

    // DELETE /api/memory/v2/entries/:id — soft delete
    if (method === 'DELETE' && idMatch) {
      const id = idMatch[1]
      await rpcClient.call(port, 'delete_memory', { id }, moduleId)
      return { status: 204 }
    }

    // GET /api/memory/v2/evolution-mode
    if (method === 'GET' && pathname === '/api/memory/v2/evolution-mode') {
      const result = await rpcClient.call(port, 'get_evolution_mode', {}, moduleId)
      return { status: 200, body: result }
    }

    // PUT /api/memory/v2/evolution-mode
    if (method === 'PUT' && pathname === '/api/memory/v2/evolution-mode') {
      if (!body) return { status: 400, body: { error: 'body required' } }
      const parsed = JSON.parse(body)
      const result = await rpcClient.call(port, 'set_evolution_mode', parsed, moduleId)
      return { status: 200, body: result }
    }

    // GET /api/memory/v2/observation-pending
    if (method === 'GET' && pathname === '/api/memory/v2/observation-pending') {
      const result = await rpcClient.call(port, 'get_observation_pending', {}, moduleId)
      return { status: 200, body: result }
    }

    // POST /api/memory/v2/maintenance/run
    if (method === 'POST' && pathname === '/api/memory/v2/maintenance/run') {
      const parsed = body ? JSON.parse(body) : {}
      const scope = parsed.scope ?? 'all'
      const result = await rpcClient.call<{ scope: string }, { report: Record<string, unknown> }>(
        port, 'run_maintenance', { scope }, moduleId,
      )
      const report = (result?.report ?? {}) as Record<string, unknown>
      const ran = MAINTENANCE_TASKS.filter((k) => k in report)
      return { status: 200, body: { ran, report } }
    }

    return { status: 404, body: { error: 'Not found' } }
  }

  return { dispatch }
}
