import { describe, expect, it } from 'vitest'
import { defineTool, type ToolDefinition } from '../../src/engine/index.js'
import {
  DAILY_REFLECTION_CORE_NAMES,
  MEMORY_GRAPH_REBUILD_CORE_NAMES,
  NORMAL_MANAGER_CORE_NAMES,
  ManagerToolCatalog,
  createManagerToolFaceState,
  managerToolProfileForSchedule,
} from '../../src/manager/tools/tool-catalog.js'

function tool(name: string, description = name): ToolDefinition {
  return defineTool({
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async () => ({ output: '', isError: false }),
  })
}

function coreTools(names: readonly string[]): ToolDefinition[] {
  return names.filter((name) => name !== 'search_tools').map((name) => tool(name))
}

describe('ManagerToolCatalog', () => {
  it.each([
    { identity: undefined, profile: 'normal' },
    { identity: { taskType: 'daily_reflection' }, profile: 'normal' },
    { identity: { scheduleId: 'memory-graph-rebuild', isBuiltin: false }, profile: 'normal' },
    { identity: { scheduleId: 'daily_reflection', isBuiltin: true }, profile: 'normal' },
    { identity: { taskType: 'memory_maintenance', isBuiltin: true }, profile: 'normal' },
    { identity: { scheduleId: 'ordinary', taskType: 'ordinary', isBuiltin: true }, profile: 'normal' },
    { identity: { taskType: 'daily_reflection', isBuiltin: true }, profile: 'daily_reflection' },
    { identity: { scheduleId: 'memory-graph-rebuild', isBuiltin: true }, profile: 'memory_graph_rebuild' },
  ])('只有可信 builtin identity 可以选择专用 profile: $identity', ({ identity, profile }) => {
    expect(managerToolProfileForSchedule(identity)).toBe(profile)
  })

  it.each([undefined, null, 7, '', '   ', '词'.repeat(501)])('拒绝非法 query %#，不改变 loaded set', (query) => {
    const catalog = new ManagerToolCatalog([tool('mcp__test__read_file')], 'normal')
    const state = createManagerToolFaceState()
    expect(() => catalog.search(state, query, undefined)).toThrow('search_tools.query')
    expect(state.loadedNames.size).toBe(0)
  })

  it.each([0, 6, 1.5, NaN, '3', null])('拒绝非法 limit %#', (limit) => {
    expect(() => new ManagerToolCatalog([], 'normal').search(createManagerToolFaceState(), 'valid', limit)).toThrow('search_tools.limit')
  })

  it('按 trim 后 Unicode 字符计数，NFKC 展开不误拒绝合法输入', () => {
    const catalog = new ManagerToolCatalog([], 'normal')
    expect(catalog.search(createManagerToolFaceState(), '𠀀'.repeat(500), 1).status).toBe('no_match')
    expect(catalog.search(createManagerToolFaceState(), 'ﬃ'.repeat(500), 1).status).toBe('no_match')
  })

  it('中文相邻词、camelCase 参数和 namespace description 均参与检索', () => {
    const catalog = new ManagerToolCatalog([
      { ...tool('mcp__archive__lookup', '星云归档查询'), searchMetadata: { namespace: 'mcp__archive', namespaceDescription: 'stored research notes' },
        inputSchema: { type: 'object', properties: { documentId: { type: 'string', description: 'document identifier' } } } },
    ], 'normal')
    for (const query of ['云归', 'documentId', 'research notes', 'mcp__archive']) {
      expect(catalog.search(createManagerToolFaceState(), query, 3).loaded, query).toEqual(['mcp__archive__lookup'])
    }
  })

  it('同分按 canonical 输入顺序；已可见 top-k 不由长尾补位', () => {
    const catalog = new ManagerToolCatalog([tool('mcp__test__z_lookup', 'needle'), tool('mcp__test__a_lookup', 'needle'), tool('mcp__test__b_lookup', 'needle')], 'normal')
    const state = createManagerToolFaceState()
    state.loadedNames.add('mcp__test__z_lookup')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(catalog.search(state, 'needle', 1)).toMatchObject({ status: 'already_visible', loaded: [], alreadyVisible: ['mcp__test__z_lookup'] })
    }
    expect([...state.loadedNames]).toEqual(['mcp__test__z_lookup'])
  })

  it('重复宽查询保持固定集合，loaded 与 already_visible 共享 limit', () => {
    const names = Array.from({ length: 8 }, (_, i) => `mcp__test__lookup_${i}`)
    const catalog = new ManagerToolCatalog(names.map(name => tool(name, '任务 trace 执行记录')), 'normal')
    const state = createManagerToolFaceState()
    state.loadedNames.add(names[0])
    const query = 'find_task get_task_progress 按时间查询任务和trace执行记录'
    expect(catalog.search(state, query, 3)).toMatchObject({ loaded: names.slice(1, 3), alreadyVisible: names.slice(0, 1) })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(catalog.search(state, query, 3)).toMatchObject({ status: 'already_visible', loaded: [], alreadyVisible: names.slice(0, 3) })
    }
    expect([...state.loadedNames]).toEqual(names.slice(0, 3))
  })

  it('预算重试只补载原集合，不把已加载项替换成集合外工具', () => {
    const catalog = new ManagerToolCatalog([
      tool('mcp__test__budget_a', 'x'.repeat(17 * 1024)), tool('mcp__test__budget_b', 'x'), tool('mcp__test__budget_c', 'x'),
    ], 'normal')
    const state = createManagerToolFaceState()
    expect(catalog.search(state, 'budget', 2)).toMatchObject({ loaded: ['mcp__test__budget_a'], omittedDueToBudget: 1 })
    expect(catalog.search(state, 'budget', 2)).toMatchObject({ loaded: ['mcp__test__budget_b'], alreadyVisible: ['mcp__test__budget_a'], omittedDueToBudget: 0 })
    expect(catalog.search(state, 'budget', 2)).toMatchObject({ status: 'already_visible', loaded: [], alreadyVisible: ['mcp__test__budget_a', 'mcp__test__budget_b'] })
    expect(state.loadedNames.has('mcp__test__budget_c')).toBe(false)
  })

  it('精确名称与 alias 不附带仅名称碎片匹配的候选', () => {
    const catalog = new ManagerToolCatalog([
      { ...tool('mcp__test__inspect_crabot', '配置摘要 config summary'), searchMetadata: { aliases: ['get_config_summary', '配置摘要'] } }, tool('mcp__test__config_summary_reader', '配置摘要 config summary'),
    ], 'normal')
    for (const query of ['mcp__test__inspect_crabot', 'get_config_summary', '配置摘要']) {
      const state = createManagerToolFaceState()
      expect(catalog.search(state, query, 3).loaded, query).toEqual(['mcp__test__inspect_crabot'])
      expect(catalog.search(state, query, 3)).toMatchObject({ loaded: [], alreadyVisible: ['mcp__test__inspect_crabot'] })
    }
  })

  it('不存在的规范名称不降级为碎片搜索，已知 namespace 仍可查询', () => {
    const catalog = new ManagerToolCatalog([
      tool('mcp__test__lookup_task', 'find task progress'), tool('mcp__archive__lookup', 'archive records'),
    ], 'normal')
    for (const query of ['find_task', 'get_task_progress', 'mcp__archive__missing']) {
      expect(catalog.search(createManagerToolFaceState(), query, 3), query)
        .toMatchObject({ status: 'no_match', loaded: [], alreadyVisible: [] })
    }
    expect(catalog.search(createManagerToolFaceState(), 'mcp__archive', 3).loaded).toEqual(['mcp__archive__lookup'])
  })

  it('内置核心名称不进入外部 MCP 搜索，不改变 loaded set', () => {
    const catalog = new ManagerToolCatalog([
      ...coreTools(NORMAL_MANAGER_CORE_NAMES), tool('mcp__test__read_worker_state', 'get worker state'),
    ], 'normal')
    const state = createManagerToolFaceState()
    expect(catalog.search(state, '  GET_WORKER_STATE  ', 3)).toMatchObject({
      status: 'no_match', loaded: [], alreadyVisible: [],
    })
    expect(state.loadedNames.size).toBe(0)
  })

  it('未授权规范名称与不存在名称一致，不从全局 byName 泄露定义', () => {
    const available = tool('mcp__test__lookup_records', 'delete records')
    const hidden = tool('mcp__test__delete_records')
    const without = new ManagerToolCatalog([available], 'normal')
    const withHidden = new ManagerToolCatalog([available, hidden], 'normal', undefined, undefined, item => item.name !== hidden.name)
    const first = without.search(createManagerToolFaceState(), hidden.name, 3)
    const second = withHidden.search(createManagerToolFaceState(), hidden.name, 3)
    expect(second).toEqual(first)
    expect(second.status).toBe('no_match')
  })

  it('first oversize 工具可单独加载，但不跳过预算后的候选去填小项', () => {
    const catalog = new ManagerToolCatalog([tool('mcp__test__budget_a', 'x'.repeat(17 * 1024)), tool('mcp__test__budget_b', 'x'), tool('mcp__test__budget_c', 'x')], 'normal')
    expect(catalog.search(createManagerToolFaceState(), 'budget', 3)).toMatchObject({
      status: 'loaded', loaded: ['mcp__test__budget_a'], omittedDueToBudget: 2,
    })
    const tooBig = new ManagerToolCatalog([tool('mcp__test__budget_huge', 'x'.repeat(65 * 1024))], 'normal')
    expect(tooBig.search(createManagerToolFaceState(), 'mcp__test__budget_huge', 1).status).toBe('no_match')
  })

  it('未知工具和授权但未加载工具有不同错误；被过滤工具不影响排名或 digest', () => {
    const allowed = tool('mcp__test__allowed', 'needle')
    const first = new ManagerToolCatalog([allowed], 'normal')
    const second = new ManagerToolCatalog([allowed, tool('mcp__test__hidden', 'needle '.repeat(200))], 'normal', undefined, undefined, (item) => item.name !== 'mcp__test__hidden')
    expect(second.authorizedCatalogDigest).toBe(first.authorizedCatalogDigest)
    expect(second.missingToolOutput('mcp__test__hidden')).toBe('TOOL_UNAVAILABLE')
    expect(second.missingToolOutput('mcp__test__allowed')).toContain('TOOL_NOT_LOADED')
    expect(second.search(createManagerToolFaceState(), 'needle', 3).loaded).toEqual(['mcp__test__allowed'])
  })

  it('full 搜索只报告有界的 already_visible，不增加 loaded set', () => {
    const catalog = new ManagerToolCatalog(Array.from({ length: 9 }, (_, i) => tool(`mcp__test__lookup_${i}`, 'lookup')), 'normal')
    const state = createManagerToolFaceState('full')
    expect(catalog.search(state, 'lookup', 3)).toMatchObject({ status: 'already_visible', loaded: [], alreadyVisible: ['mcp__test__lookup_0', 'mcp__test__lookup_1', 'mcp__test__lookup_2'] })
    expect(state.loadedNames.size).toBe(0)
  })

  it('projects the fixed normal core and appends loaded tools without reordering', () => {
    const tools = [
      ...coreTools(NORMAL_MANAGER_CORE_NAMES),
      { ...tool('mcp__test__inspect_crabot', 'deployment config capabilities'), searchMetadata: { aliases: ['get_config_summary', '部署信息'] } },
      tool('mcp__test__get_schedule', 'read schedule details'),
    ]
    const catalog = new ManagerToolCatalog(tools, 'normal')
    const state = createManagerToolFaceState()
    const search = tool('search_tools')

    expect(catalog.project(state, search).map((item) => item.name)).toEqual([...NORMAL_MANAGER_CORE_NAMES])

    const result = catalog.search(state, 'schedule', 3)
    expect(result.status).toBe('loaded')
    expect(result.loaded).toContain('mcp__test__get_schedule')
    expect(catalog.project(state, search).map((item) => item.name)).toEqual([
      ...NORMAL_MANAGER_CORE_NAMES,
      'mcp__test__get_schedule',
    ])

    const second = catalog.search(state, 'schedule', 3)
    expect(second.status).toBe('already_visible')
    expect(second.loaded).toEqual([])
  })

  it('searches external metadata aliases but returns only the canonical tool name', () => {
    const catalog = new ManagerToolCatalog([
      ...coreTools(NORMAL_MANAGER_CORE_NAMES),
      { ...tool('mcp__test__inspect_crabot', 'deployment config capabilities'), searchMetadata: { aliases: ['get_config_summary', '部署信息'] } },
    ], 'normal')
    const state = createManagerToolFaceState()

    const first = catalog.search(state, 'get_config_summary', 3)
    expect(first.loaded).toEqual(['mcp__test__inspect_crabot'])
    expect(first.loaded).not.toContain('get_config_summary')

    const second = catalog.search(state, '部署信息', 3)
    expect(second.status).toBe('already_visible')
    expect(second.alreadyVisible).toEqual(['mcp__test__inspect_crabot'])
  })

  it('keeps daily reflection narrow and excludes external MCP from its catalog', () => {
    const catalog = new ManagerToolCatalog([
      ...coreTools(DAILY_REFLECTION_CORE_NAMES),
      tool('mcp__crab-memory__list_recent', 'recent memory entries'),
      tool('mcp__test__inspect_crabot', 'deployment information'),
      tool('mcp__notion__search', 'search documents'),
    ], 'daily_reflection')
    const state = createManagerToolFaceState()
    const search = tool('search_tools')

    expect(catalog.project(state, search).map((item) => item.name)).toEqual([...DAILY_REFLECTION_CORE_NAMES])
    expect(catalog.search(state, 'deployment', 3).status).toBe('no_match')
    expect(catalog.search(state, 'recent memory', 3).status).toBe('no_match')
  })

  it('does not expose search_tools in the memory graph rebuild profile', () => {
    const catalog = new ManagerToolCatalog(coreTools(MEMORY_GRAPH_REBUILD_CORE_NAMES), 'memory_graph_rebuild')
    const state = createManagerToolFaceState()
    expect(catalog.project(state).map((item) => item.name)).toEqual([...MEMORY_GRAPH_REBUILD_CORE_NAMES])
  })
})
