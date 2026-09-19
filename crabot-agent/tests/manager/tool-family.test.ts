import { describe, expect, it } from 'vitest'
import { defineTool } from '../../src/engine/index.js'
import { ManagerToolCatalog, createManagerToolFaceState, NORMAL_MANAGER_CORE_NAMES } from '../../src/manager/tools/tool-catalog.js'

const tool = (name: string, description = name) => defineTool({ name, description,
  inputSchema: { type: 'object', properties: {} }, isReadOnly: true,
  call: async () => { throw new Error('Discovery must not execute business tools') },
})
const memory = Array.from({ length: 18 }, (_, i) => tool(`mcp__crab-memory__entry_${i}`, '记忆 ' + 'x'.repeat(1200)))
const create = (profile = 'normal', allowed = (_t: { name: string }) => true) => new ManagerToolCatalog(
  [...memory, tool('get_schedule'), tool('inspect_crabot'), tool('mcp__remote__lookup', 'external lookup'), tool('mcp__remote__read', 'external lookup')],
  profile as 'normal', undefined, undefined, allowed,
  { memory: memory.map(t => t.name), schedule: ['get_schedule'], crabot: ['inspect_crabot'] },
)

describe('complete tool family loading', () => {
  it('loads all 18 members beyond search budgets and is idempotent', () => {
    const catalog = create(); const state = createManagerToolFaceState()
    expect(catalog.loadFamily(state, 'memory')).toMatchObject({ status: 'loaded', complete: true, loaded: memory.map(t => t.name), already_visible: [] })
    expect(catalog.loadFamily(state, 'memory')).toMatchObject({ status: 'already_visible', complete: true, loaded: [], already_visible: memory.map(t => t.name) })
    expect([...state.loadedNames]).toEqual(memory.map(t => t.name))
    expect(createManagerToolFaceState().loadedNames.size).toBe(0)
  })
  it('filters authorization before reporting completeness, and hides forbidden families', () => {
    const catalog = create('normal', t => t.name.endsWith('entry_1'))
    expect(catalog.loadFamily(createManagerToolFaceState(), 'memory').loaded).toEqual([memory[1].name])
    for (const family of ['schedule', 'missing']) {
      expect(catalog.loadFamily(createManagerToolFaceState(), family)).toMatchObject({ status: 'unavailable', complete: false, loaded: [], already_visible: [] })
    }
  })
  it('excludes every builtin from external MCP search', () => {
    const catalog = create()
    for (const query of ['记忆', 'mcp__crab-memory', memory[0].name, 'get_schedule', 'inspect_crabot']) {
      expect(catalog.search(createManagerToolFaceState(), query, 5).status, query).toBe('no_match')
    }
    expect(catalog.search(createManagerToolFaceState(), 'external lookup', 5).loaded).toHaveLength(2)
  })
  it('lists authorized MCP namespaces without loading and retrieves a complete known server', () => {
    const catalog = create(); const state = createManagerToolFaceState()
    expect(catalog.loadFamily(state, 'mcp')).toMatchObject({ status: 'listed', complete: true, families: [{ family: 'mcp__remote', tool_count: 2 }], loaded: [] })
    expect(state.loadedNames.size).toBe(0)
    expect(catalog.loadFamily(state, 'mcp__remote')).toMatchObject({ complete: true, loaded: ['mcp__remote__lookup', 'mcp__remote__read'] })
  })
  it('restricts daily to memory/worker and graph to its fixed core', () => {
    const daily = create('daily_reflection')
    expect(daily.loadFamily(createManagerToolFaceState(), 'memory').loaded).toHaveLength(18)
    for (const family of ['schedule', 'crabot', 'mcp', 'mcp__remote']) {
      expect(daily.loadFamily(createManagerToolFaceState(), family).status).toBe('unavailable')
    }
    expect(create('memory_graph_rebuild').loadFamily(createManagerToolFaceState(), 'memory').status).toBe('unavailable')
  })
  it('uses the connector server identity when its name contains a double underscore', () => {
    const remote = { ...tool('mcp__my__archive__read'), traceMetadata: { mcp_server: 'my__archive' } }
    const catalog = new ManagerToolCatalog([remote], 'normal')
    expect(catalog.loadFamily(createManagerToolFaceState(), 'mcp').families).toEqual([{ family: 'mcp__my__archive', tool_count: 1 }])
    expect(catalog.loadFamily(createManagerToolFaceState(), 'mcp__my__archive').loaded).toEqual([remote.name])
  })
  it('a hidden external server affects neither service listing nor authorized catalog revision', () => {
    const visible = tool('mcp__visible__read')
    const hidden = tool('mcp__hidden__read')
    const a = new ManagerToolCatalog([visible], 'normal')
    const b = new ManagerToolCatalog([visible, hidden], 'normal', undefined, undefined, t => t !== hidden)
    expect(a.loadFamily(createManagerToolFaceState(), 'mcp')).toEqual(b.loadFamily(createManagerToolFaceState(), 'mcp'))
    expect(b.loadFamily(createManagerToolFaceState(), 'mcp__hidden').status).toBe('unavailable')
  })
  it.each([null, undefined, 3, '', '   ', 'x'.repeat(129)])('rejects invalid family %s without mutation', family => {
    const state = createManagerToolFaceState()
    expect(() => create().loadFamily(state, family)).toThrow()
    expect(state.loadedNames.size).toBe(0)
  })
  it('keeps visible core members and appends only new family members', () => {
    const core = NORMAL_MANAGER_CORE_NAMES.filter(n => n !== 'search_tools').map(n => tool(n))
    const catalog = new ManagerToolCatalog([...core, tool('query_worker')], 'normal', undefined, undefined, () => true,
      { worker: ['get_worker_state', 'query_worker'] })
    const state = createManagerToolFaceState(); const search = tool('search_tools')
    const before = catalog.project(state, search)
    expect(catalog.loadFamily(state, 'worker')).toMatchObject({ loaded: ['query_worker'], already_visible: ['get_worker_state'] })
    expect(catalog.project(state, search).map(t => t.name)).toEqual([...before.map(t => t.name), 'query_worker'])
  })
})
