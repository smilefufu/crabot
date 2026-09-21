/**
 * manager 封闭工具面装配测试 —— protocol-agent-v3.md §4.3。
 *
 * 覆盖：
 * - 普通 manager 工具名集合精确匹配预期清单（含 send_private_message，protocol-crab-messaging §1）
 * - 系统线程（isSystemThread）多出 send_master_private，其余不变
 * - 飞书 channel 存在时多出 §2.10 的只读三件套，且**任何情况下都不含 feishu_write**
 * - 运行时护栏对注入的违规工具（通用文件系统工具 / 外装 mcp__ 工具）抛错，crab-memory 前缀放行
 * - isReadOnly 标记正确（messaging 只读子集 / worker 观察工具 / crabot-info 六件套）
 * - 三个投递工具要求声明 post_send_action；send_message 不暴露/透传 intent，并记录真实投递
 * - 可见性门与运行时门同源：可见的 send_private_message 真调一次不被 requireDeclaredShortcut 拦
 */
import { describe, it, expect, vi } from 'vitest'
import { executeToolBatches } from '../../src/engine/tool-orchestration'
import { buildManagerToolFace, assertClosedToolFace, type ToolFaceDeps } from '../../src/manager/tools/tool-face'
import { CRAB_MEMORY_MANAGER_TOOL_NAMES, createCrabMemoryServer } from '../../src/mcp/crab-memory'
import { createCrabMessagingServer } from '../../src/mcp/crab-messaging'
import { mcpServerToToolDefinitions } from '../../src/agent/mcp-tool-bridge'
import type { WorkerHarness } from '../../src/workers/harness/harness'
import type { ToolDefinition } from '../../src/engine/index'
import { ManagerWorkboardStore } from '../../src/manager/workboard-store.js'
import type { ManagerKey } from '../../src/manager/types.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createManagerToolFaceState, NORMAL_MANAGER_CORE_NAMES, DAILY_REFLECTION_CORE_NAMES, MEMORY_GRAPH_REBUILD_CORE_NAMES } from '../../src/manager/tools/tool-catalog.js'
import type { ResolvedPermissions } from '../../src/types.js'
import { runEngine } from '../../src/engine/query-loop.js'
import type { EngineTurnEvent, LLMAdapter } from '../../src/engine/index.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import { TOOL_SEARCH_QUERIES } from './fixtures/tool-search-queries.js'
import { callNonStreaming, createAdapter } from '../../src/engine/llm-adapter.js'
import { createUserMessage } from '../../src/engine/types.js'

/**
 * 普通 manager 的 messaging 工具（无飞书 channel 实例时）。
 * `send_private_message` 在列——protocol-crab-messaging.md §1 投递类可见性表「普通 manager = 是」。
 */
const MESSAGING_NORMAL = [
  'send_message',
  'send_private_message',
  'get_history',
  'get_message',
  'lookup_friend',
  'list_sessions',
  'list_contacts',
  'list_groups',
  'list_group_members',
  'fetch_media',
]

/** protocol-crab-messaging.md §2.10 的 channel 透传只读三件套（仅当存在飞书 channel 实例）。 */
const FEISHU_READ_ONLY_TOOLS = ['read_feishu_document', 'feishu_raw_get', 'feishu_download_file']

const WORKER_TOOLS = ['spawn_worker', 'send_to_worker', 'query_worker', 'get_worker_state', 'get_worker_activity', 'get_worker_turn', 'resolve_worker_turn', 'get_worker_terminal', 'request_worker_interrupt', 'request_worker_stop', 'respond_to_worker_ui', 'list_workers', 'get_worker_detail', 'list_worker_implementations']

const CRABOT_INFO_TOOLS = [
  'inspect_crabot',
  'list_schedules',
  'get_friend_permissions',
]

const CONTEXT_TOOLS = [
  'load_guidance',
  'get_execution_capabilities',
  'inspect_workspace_git',
  'inspect_workboard',
  'change_workboard',
  'inspect_project_docs',
]

const MANAGER_KEY = 'ch-1::sess-1' as ManagerKey

function makeMemoryServer() {
  return createCrabMemoryServer(
    {
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'manager-test',
      getMemoryPort: async () => 19100,
    },
    {
      visibility: 'internal',
      scopes: [],
      isMasterPrivate: false,
    },
  )
}

function makeMessagingDeps(extra: Partial<ToolFaceDeps['messagingDeps']> = {}): ToolFaceDeps['messagingDeps'] {
  return {
    rpcClient: { call: vi.fn() } as never,
    moduleId: 'manager-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
    ...extra,
  }
}

function makeDeps(overrides: Partial<ToolFaceDeps> = {}): ToolFaceDeps {
  return {
    harness: {} as unknown as WorkerHarness,
    workerContext: () => ({
      managerKey: MANAGER_KEY,
      reportTo: { channel_id: 'ch-1', session_id: 'sess-1' },
    }),
    messagingDeps: makeMessagingDeps(),
    memoryServer: makeMemoryServer(),
    callAdmin: vi.fn(async () => ({})) as unknown as ToolFaceDeps['callAdmin'],
    isSystemThread: false,
    workboard: {
      store: new ManagerWorkboardStore(join(tmpdir(), 'manager-tool-face-test')),
      managerKey: MANAGER_KEY,
    },
    projectDocs: {
      ledger: {
        listWorkers: vi.fn(async () => []),
        findWorker: vi.fn(async () => undefined),
      } as never,
      readWorkerContext: vi.fn(async () => undefined),
      managerKey: MANAGER_KEY,
    },
    ...overrides,
  }
}

function memoryToolNames(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.name).filter((n) => n.startsWith('mcp__crab-memory__'))
}

describe('每日反思保留历史 inbox 的人工迁移边界', () => {
  const writes = [
    ['promote_inbox_entry', { id: 'legacy' }, 'promote_inbox_entry'],
    ['delete_memory', { id: 'legacy' }, 'delete_memory'],
    ['update_long_term', { id: 'legacy', patch: { body: 'replacement' } }, 'update_long_term'],
    ['set_memory_links', { id: 'legacy', links: [] }, 'update_long_term'],
  ] as const

  async function face(call: ReturnType<typeof vi.fn>, mode: 'full' | 'progressive', daily = true) {
    const deps = makeDeps({
      isBuiltinDailyReflection: daily,
      faceState: createManagerToolFaceState(mode),
      candidatePermissions: { tool_access: { memory: true }, cli_access: {} } as ResolvedPermissions,
      memoryServer: createCrabMemoryServer({
        rpcClient: { call } as never, moduleId: 'manager-test', getMemoryPort: async () => 19100,
      }, { visibility: 'internal', scopes: [], isMasterPrivate: false }),
    })
    const initial = buildManagerToolFace(deps)
    if (mode === 'progressive') {
      await initial.find(t => t.name === 'load_tool_family')!.call({ family: 'memory' }, {} as never)
    }
    return buildManagerToolFace(deps)
  }

  for (const mode of ['full', 'progressive'] as const) {
    it(`${mode}: continuation query filters normal inbox before RPC pagination`, async () => {
      const call = vi.fn(async () => ({ items: [], total: 0 }))
      const tools = await face(call, mode)
      const list = tools.find(t => t.name === 'mcp__crab-memory__list_entries')!
      expect((await list.call({ status: 'inbox', sort: 'ingestion_time_asc', offset: 20 }, {} as never)).isError).toBe(false)
      expect(call).toHaveBeenCalledWith(19100, 'list_entries',
        expect.objectContaining({ status: 'inbox', reviewable_only: true, offset: 20 }), 'manager-test')
    })

    it.each(writes)(`${mode}: %s 不得修改缺少生命周期字段的历史候选`, async (name, input) => {
      const call = vi.fn(async (_port, method) => method === 'get_memory'
        ? { id: 'legacy', status: 'inbox', frontmatter: {}, body: 'original' }
        : { status: 'ok' })
      const tools = await face(call, mode)
      const result = await tools.find(t => t.name === `mcp__crab-memory__${name}`)!.call(input, {} as never)
      expect(result.isError).toBe(true)
      expect(result.output).toContain('历史 inbox')
      expect(call.mock.calls.map(c => c[1])).toEqual(['get_memory'])
    })
  }

  it.each([{ reviewable_only: false }, { reviewable_only: null }, { reviewable_only: 'true' },
    { ingestion_time_start: '2026-08-02' }, { ingestion_time_end: '2026-09-18' }])(
    'continuation query rejects a daily inbox override without calling Memory: %j', async extra => {
      const call = vi.fn()
      const tools = await face(call, 'progressive')
      const result = await tools.find(t => t.name === 'mcp__crab-memory__list_entries')!.call({ status: 'inbox', ...extra }, {} as never)
      expect(result.isError).toBe(true)
      expect(call).not.toHaveBeenCalled()
    })

  it.each([[false, 'inbox'], [true, 'confirmed'], [true, 'trash']] as const)(
    'continuation query preserves other list scopes: daily=%s status=%s', async (daily, status) => {
      const call = vi.fn(async () => ({ items: [], total: 0 }))
      const tools = await face(call, 'progressive', daily)
      await tools.find(t => t.name === 'mcp__crab-memory__list_entries')!.call({ status, ingestion_time_start: '2026-08-02' }, {} as never)
      expect(call).toHaveBeenCalledWith(19100, 'list_entries', { status, ingestion_time_start: '2026-08-02' }, 'manager-test')
    })

  it.each(writes)('%s 保留带生命周期字段的正常候选处理', async (name, input, method) => {
    const call = vi.fn(async (_port, m) => m === 'get_memory'
      ? { id: 'legacy', status: 'inbox', frontmatter: { inbox_entered_at: '2026-09-20T00:00:00Z' } }
      : { status: 'ok' })
    const tools = await face(call, 'progressive')
    const result = await tools.find(t => t.name === `mcp__crab-memory__${name}`)!.call(input, {} as never)
    expect(result.isError).toBe(false)
    expect(call.mock.calls.map(c => c[1])).toEqual(['get_memory', method])
  })

  it('普通主控的人工操作不套用每日反思限制', async () => {
    const call = vi.fn(async () => ({ status: 'ok' }))
    const tools = await face(call, 'progressive', false)
    await tools.find(t => t.name === 'mcp__crab-memory__delete_memory')!.call({ id: 'legacy' }, {} as never)
    expect(call.mock.calls.map(c => c[1])).toEqual(['delete_memory'])
  })

  it.each(['confirmed', 'trash'])('%s 缺少 inbox_entered_at 不被误当历史 inbox', async status => {
    const call = vi.fn(async (_port, method) => method === 'get_memory'
      ? { id: 'legacy', status, frontmatter: {} } : { status: 'ok' })
    const tools = await face(call, 'progressive')
    const result = await tools.find(t => t.name === 'mcp__crab-memory__delete_memory')!.call({ id: 'legacy' }, {} as never)
    expect(result.isError).toBe(false)
    expect(call.mock.calls.map(c => c[1])).toEqual(['get_memory', 'delete_memory'])
  })

  it.each([
    { error: 'unavailable' },
    { id: 'other', status: 'inbox', frontmatter: { inbox_entered_at: '2026-09-20T00:00:00Z' } },
    { id: 'legacy', status: 'inbox' },
  ])('无法核实目标状态时不执行写入：%j', async detail => {
    const call = vi.fn(async () => detail)
    const tools = await face(call, 'progressive')
    const result = await tools.find(t => t.name === 'mcp__crab-memory__delete_memory')!.call({ id: 'legacy' }, {} as never)
    expect(result.isError).toBe(true)
    expect(call.mock.calls.map(c => c[1])).toEqual(['get_memory'])
  })

  it('每次写入核对当前状态，不缓存旧的准入结论', async () => {
    let enteredAt: string | undefined = '2026-09-20T00:00:00Z'
    const call = vi.fn(async (_port, method) => method === 'get_memory'
      ? { id: 'legacy', status: 'inbox', frontmatter: { inbox_entered_at: enteredAt } } : { status: 'ok' })
    const tools = await face(call, 'progressive')
    const update = tools.find(t => t.name === 'mcp__crab-memory__update_long_term')!
    expect((await update.call({ id: 'legacy', patch: { body: 'one' } }, {} as never)).isError).toBe(false)
    enteredAt = undefined
    expect((await update.call({ id: 'legacy', patch: { body: 'two' } }, {} as never)).isError).toBe(true)
    expect(call.mock.calls.map(c => c[1])).toEqual(['get_memory', 'update_long_term', 'get_memory'])
  })

  it('重放同批6次确认和14次删除：Engine保留失败回包，20个历史条目均不变', async () => {
    const entries = new Map(Array.from({ length: 20 }, (_, i) => [`legacy-${i}`, {
      id: `legacy-${i}`, status: 'inbox', frontmatter: {}, body: `original-${i}`,
    }]))
    const before = structuredClone([...entries])
    const call = vi.fn(async (_port, method, input) => {
      const entry = entries.get(input.id)!
      if (method === 'get_memory') return entry
      entry.status = method === 'delete_memory' ? 'trash' : 'confirmed'
      return { status: 'ok' }
    })
    const tools = await face(call, 'progressive')
    let requests = 0
    const adapter: LLMAdapter = {
      updateConfig() {},
      async *stream() {
        if (requests++ === 0) yield* chunksFromContent(Array.from({ length: 20 }, (_, i) => ({
          type: 'tool_use' as const, id: `write-${i}`,
          name: `mcp__crab-memory__${i < 6 ? 'promote_inbox_entry' : 'delete_memory'}`,
          input: { id: `legacy-${i}` },
        })), 'tool_use')
        else yield* chunksFromContent([{ type: 'text', text: '历史候选留待人工迁移。' }], 'end_turn')
      },
    }
    const turns: EngineTurnEvent[] = []
    await runEngine({ prompt: '验收历史候选保护', adapter, options: {
      model: 'fixture', systemPrompt: 'fixture', tools, maxTurns: 2,
      suppressForcedSummary: () => true, onTurn: turn => { turns.push(turn) },
    } })
    expect(requests).toBe(2)
    expect(turns.flatMap(turn => turn.toolCalls)).toHaveLength(20)
    expect(turns.flatMap(turn => turn.toolCalls).every(call => call.isError)).toBe(true)
    expect([...entries]).toEqual(before)
    expect(call).toHaveBeenCalledTimes(20)
    expect(call.mock.calls.every(c => c[1] === 'get_memory')).toBe(true)
  })
})

describe('buildManagerToolFace', () => {
  const permissions: ResolvedPermissions = {
    tool_access: { memory: true, messaging: true, task: true, mcp_skill: true, file_io: true, browser: true, shell: true, remote_exec: true, desktop: true },
    cli_access: { provider: 'write', agent: 'write', mcp: 'write', skill: 'write', schedule: 'write', channel: 'write', friend: 'write', permission: 'write', config: 'write', undo: 'write' },
    storage: null, memory_scopes: [],
  }
  const schedule = {
    targetSession: { channel_id: 'ch-1', session_id: 'sess-1', type: 'private' as const }, creatorFriendId: 'creator',
    canCreate: true, resolvePermissions: async () => permissions,
  }

  it.each(['full', 'progressive'] as const)('%s 普通首次改板直接执行，不以自省指南作为前置条件', async (mode) => {
    const objective = { objective_id: 'fixture', title: 'fixture', completion_criteria: ['done'], work_items: [], updated_at: '2026-09-17T00:00:00Z' }
    const store = { createObjective: vi.fn(async () => ({ value: objective, board: { objectives: [objective], archive: [] } })) }
    const faceState = createManagerToolFaceState(mode)
    faceState.loadedNames.add('change_workboard')
    const deps = makeDeps({ faceState, workboard: { managerKey: MANAGER_KEY, store: store as never } })
    const firstFace = buildManagerToolFace(deps)
    const cachedFace = buildManagerToolFace(deps)
    const change = cachedFace.find(tool => tool.name === 'change_workboard')!
    expect(change).toBe(firstFace.find(tool => tool.name === 'change_workboard'))
    const input = { action: 'create_objective', objective: { title: 'fixture', completion_criteria: ['done'] } }
    const first = await change.call(input, {} as never)
    expect(first.isError).toBe(false)
    expect(JSON.parse(first.output)).toMatchObject({ action: 'objective_created' })
    expect(first.output).not.toContain('guidance_provided')
    expect(store.createObjective).toHaveBeenCalledOnce()
    expect(store.createObjective).toHaveBeenCalledWith(MANAGER_KEY, input.objective)
    const nextState = createManagerToolFaceState(mode)
    nextState.loadedNames.add('change_workboard')
    const nextFace = buildManagerToolFace({ ...deps, faceState: nextState })
    expect(JSON.parse((await nextFace.find(tool => tool.name === 'change_workboard')!.call(input, {} as never)).output))
      .toMatchObject({ action: 'objective_created' })
    expect(store.createObjective).toHaveBeenCalledTimes(2)
  })

  it('普通首次改板真实错误原样返回，不由指南回执掩盖', async () => {
    const store = { createObjective: vi.fn(async () => { throw new Error('WORKBOARD_UNREAD_ADMIN_UPDATE') }) }
    const tools = buildManagerToolFace(makeDeps({ workboard: { managerKey: MANAGER_KEY, store: store as never } }))
    const result = await tools.find(tool => tool.name === 'change_workboard')!.call({
      action: 'create_objective', objective: { title: 'fixture', completion_criteria: ['done'] },
    }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('WORKBOARD_UNREAD_ADMIN_UPDATE')
    expect(store.createObjective).toHaveBeenCalledOnce()
  })

  it('每日反思和图谱场景不提供普通 guidance；缺 task 的普通会话仍能查询执行条件', () => {
    for (const profile of ['daily_reflection', 'memory_graph_rebuild'] as const) {
      const tools = buildManagerToolFace(makeDeps({ profile, isBuiltinDailyReflection: profile === 'daily_reflection', faceState: createManagerToolFaceState() }))
      expect(tools.map(tool => tool.name)).not.toContain('load_guidance')
      expect(tools.map(tool => tool.name)).not.toContain('get_execution_capabilities')
    }
    const tools = buildManagerToolFace(makeDeps({ candidatePermissions: { ...permissions, tool_access: { ...permissions.tool_access, task: false } }, faceState: createManagerToolFaceState() }))
    expect(tools.map(tool => tool.name)).toContain('get_execution_capabilities')
  })

  it('移除决策写入后为 56 项内置与 58 项 full，各模式核心字节一致', () => {
    const deps = makeDeps({ schedule, candidatePermissions: permissions })
    expect(buildManagerToolFace(deps)).toHaveLength(56)
    const full = buildManagerToolFace({ ...deps, faceState: createManagerToolFaceState('full') })
    const core = buildManagerToolFace({ ...deps, faceState: createManagerToolFaceState() })
    expect(full).toHaveLength(58)
    expect(core.map((tool) => tool.name)).toEqual([...NORMAL_MANAGER_CORE_NAMES])
    const wire = (tools: ToolDefinition[]) => JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })))
    expect(wire(full.slice(0, NORMAL_MANAGER_CORE_NAMES.length))).toBe(wire(core))
    expect(Buffer.byteLength(wire(core))).toBeLessThanOrEqual(22 * 1024)
    const restricted = buildManagerToolFace({ ...deps, candidatePermissions: undefined, faceState: createManagerToolFaceState() })
    expect(wire(restricted)).toBe(wire(core))
  })

  it.each(['full', 'shadow', 'progressive'] as const)('已移除的决策写工具在 %s 模式的旧加载记录、搜索及降级中都不可执行', async (mode) => {
    const state = createManagerToolFaceState(mode)
    state.loadedNames.add('manage_decision_doc')
    const deps = makeDeps({ faceState: state, candidatePermissions: permissions })
    const tools = buildManagerToolFace(deps)
    expect(tools.some(tool => tool.name === 'manage_decision_doc')).toBe(false)
    const search = tools.find(tool => tool.name === 'search_tools')!
    const found = JSON.parse((await search.call({ query: 'manage_decision_doc', limit: 5 }, {})).output)
    expect([...found.loaded, ...found.already_visible]).not.toContain('manage_decision_doc')
    vi.spyOn(state.catalog!, 'search').mockImplementationOnce(() => { throw new Error('index failed') })
    expect(JSON.parse((await search.call({ query: 'decision' }, {})).output).status).toBe('degraded')
    expect(buildManagerToolFace(deps).some(tool => tool.name === 'manage_decision_doc')).toBe(false)
    const turns: EngineTurnEvent[] = []
    let calls = 0
    const adapter: LLMAdapter = {
      async *stream() {
        if (calls++ === 0) yield* chunksFromContent([
          { type: 'tool_use', id: 'old-write', name: 'manage_decision_doc', input: { action: 'create', content: '# obsolete' } },
        ], 'tool_use')
        else yield* chunksFromContent([{ type: 'text', text: '工具不可用，按当前职责续办。' }], 'end_turn')
      },
      updateConfig() {},
    }
    await runEngine({ prompt: '恢复旧调用', adapter, options: {
      model: 'test', systemPrompt: 'test', maxTurns: 2, tools: () => buildManagerToolFace(deps),
      onTurn: turn => { turns.push(turn) },
      unavailableToolResult: name => ({ output: state.catalog!.missingToolOutput(name), isError: true }),
    } })
    expect(turns[0].toolCalls[0]).toMatchObject({ isError: true, output: expect.stringContaining('TOOL_UNAVAILABLE') })
    expect(deps.callAdmin).not.toHaveBeenCalled()
  })

  it('daily has exactly 11 core tools and can discover execution capabilities, ordinary profile cannot load reflection tools', async () => {
    const state = createManagerToolFaceState()
    const deps = makeDeps({ faceState: state, profile: 'daily_reflection', isBuiltinDailyReflection: true })
    const tools = buildManagerToolFace(deps)
    expect(tools.map(tool => tool.name)).toEqual([...DAILY_REFLECTION_CORE_NAMES])
    expect(tools).toHaveLength(11)
    expect(state.catalog!.loadFamily(state, 'worker').loaded).toContain('get_execution_capabilities')
    const normal = createManagerToolFaceState()
    buildManagerToolFace(makeDeps({ faceState: normal, candidatePermissions: permissions }))
    for (const name of ['list_reflection_records', 'read_reflection_record', 'finish_daily_reflection']) {
      expect(normal.catalog!.get(name)).toBeUndefined()
      expect(normal.catalog!.search(normal, name, 1).loaded).not.toContain(name)
    }
  })

  it('episode 固定目录，搜索后下一轮追加；schema 变化只影响新 episode', async () => {
    const state = createManagerToolFaceState()
    const deps = makeDeps({ schedule, candidatePermissions: permissions, faceState: state })
    const core = buildManagerToolFace(deps)
    const result = await core.find(tool => tool.name === 'load_tool_family')!.call({ family: 'schedule' }, {})
    expect(JSON.parse(result.output).loaded).toContain('create_schedule')
    const next = buildManagerToolFace({ ...deps, messagingDeps: makeMessagingDeps({ enableFeishuDocTool: true }) })
    expect(next.map((tool) => tool.name)).toEqual([...NORMAL_MANAGER_CORE_NAMES, 'create_schedule', 'delete_schedule', 'get_schedule', 'list_schedules', 'trigger_schedule', 'update_schedule'])
    expect(state.catalog?.get('read_feishu_document')).toBeUndefined()
  })

  it.each(['anthropic', 'openai', 'openai-responses'] as const)('%s 实际 wire 保持核心前缀，记录完整/核心/追加后的 schema bytes', async (format) => {
    const bodies: Array<Record<string, any>> = []
    const requestBytes: number[] = []
    const fetchMock = vi.fn(async (_url, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      requestBytes.push(Buffer.byteLength(init.body as string))
      let data: string
      if (format === 'anthropic') {
        const events = [
          { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', content: [], model: 'fixture', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
        data = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      } else if (format === 'openai-responses') {
        data = `event: response.completed\ndata: ${JSON.stringify({ response: { id: 'fixture', output: [] } })}\n\n`
      } else {
        data = `data: ${JSON.stringify({ id: 'fixture', choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      }
      return new Response(data, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const deps = makeDeps({ schedule, candidatePermissions: permissions })
      const full = buildManagerToolFace({ ...deps, faceState: createManagerToolFaceState('full') })
      const state = createManagerToolFaceState()
      const core = buildManagerToolFace({ ...deps, faceState: state })
      await core.find(tool => tool.name === 'load_tool_family')!.call({ family: 'schedule' }, {})
      const expanded = buildManagerToolFace({ ...deps, faceState: state })
      const adapter = createAdapter({ endpoint: 'https://example.test/v1', apikey: 'test-key', format })
      // This SDK version captures node-fetch at import time, not globalThis.fetch.
      if (format === 'anthropic') vi.spyOn((adapter as any).client, 'fetch').mockImplementation(fetchMock)
      for (const tools of [full, core, expanded]) {
        await callNonStreaming(adapter, { model: 'fixture', systemPrompt: 'Stable Manager instructions', messages: [createUserMessage('fixture')], tools, maxTokens: 64 })
      }
      expect(bodies.map(body => body.tools.length)).toEqual([58, 15, 21])
      expect(JSON.stringify(bodies[0].tools.slice(0, NORMAL_MANAGER_CORE_NAMES.length))).toBe(JSON.stringify(bodies[1].tools))
      expect(JSON.stringify(bodies[2].tools.slice(0, NORMAL_MANAGER_CORE_NAMES.length))).toBe(JSON.stringify(bodies[1].tools))
      if (format === 'anthropic') {
        expect(bodies.every(body => body.tools[NORMAL_MANAGER_CORE_NAMES.length - 1].cache_control?.type === 'ephemeral')).toBe(true)
        expect(bodies.every(body => (JSON.stringify(body).match(/cache_control/g) ?? []).length <= 4)).toBe(true)
      } else {
        expect(new Set(bodies.map(body => body.prompt_cache_key)).size).toBe(1)
        expect(bodies[0].prompt_cache_key).toMatch(/^[a-f0-9]{64}$/)
      }
      expect(JSON.stringify(bodies)).not.toMatch(/cacheBreakpoint|traceMetadata|additional_tools|prompt_cache_options/)
      const bytes = bodies.map(body => Buffer.byteLength(JSON.stringify(body.tools)))
      expect(bytes[1]).toBeLessThan(bytes[0])
      console.info('manager-tool-wire-bytes', { format, full: bytes[0], core: bytes[1], with_schedule: bytes[2], request_bytes: requestBytes })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('每项实际内置尾部工具恰属一个完整族，搜索不再返回内置定义', () => {
    const state = createManagerToolFaceState()
    buildManagerToolFace(makeDeps({
      schedule, candidatePermissions: permissions, faceState: state, isSystemThread: true,
      messagingDeps: makeMessagingDeps({ enableFeishuDocTool: true }),
      authorization: () => ({ kind: 'friend_master', manager_key: MANAGER_KEY, friend_id: 'master', generation: 1 }),
    }))
    const catalog = state.catalog!
    const tailNames = catalog.tools.map(tool => tool.name).filter(name => !(NORMAL_MANAGER_CORE_NAMES as readonly string[]).includes(name))
    expect(TOOL_SEARCH_QUERIES.map(([name]) => name).sort()).toEqual(tailNames.sort())
    const families = ['memory', 'messaging', 'worker', 'schedule', 'crabot'].map(family => catalog.loadFamily(createManagerToolFaceState(), family))
    for (const [name, ...queries] of TOOL_SEARCH_QUERIES) {
      expect(families.filter(result => result.loaded.includes(name)), name).toHaveLength(1)
      for (const query of [name, ...queries]) expect(catalog.search(createManagerToolFaceState(), query, 3).status).toBe('no_match')
    }
    expect(families[0].loaded).toHaveLength(18)
    expect(families[3].loaded).toHaveLength(6)
  })

  it('MCP 已加载后撤权拒绝执行，未知 category 不进入目录', async () => {
    let authorized = true
    const call = vi.fn(async () => ({ output: 'result', isError: false }))
    const external = { name: 'mcp__remote__lookup', description: 'remote lookup', category: 'mcp_skill' as const, inputSchema: { type: 'object' }, isReadOnly: false, call }
    const state = createManagerToolFaceState()
    const deps = makeDeps({ faceState: state, candidatePermissions: permissions, externalMcpTools: [external, { ...external, name: 'mcp__remote__unknown', category: undefined }],
      authorizeExternalMcpTool: async () => authorized })
    await buildManagerToolFace(deps)[0].call({ query: external.name }, {})
    const loaded = buildManagerToolFace(deps).find((tool) => tool.name === external.name)!
    authorized = false
    expect(await loaded.call({}, {})).toMatchObject({ output: 'TOOL_CATALOG_CHANGED', isError: true })
    expect(call).not.toHaveBeenCalled()
    expect(state.catalog?.missingToolOutput('mcp__remote__unknown')).toBe('TOOL_UNAVAILABLE')
  })

  it.each(['search_tools', 'load_tool_family'])('真实 Engine 同轮 %s 不能调用新 MCP，下一轮才可执行，重新开始不继承 loaded set', async (loader) => {
    const call = vi.fn(async () => ({ output: 'external result', isError: false }))
    const external = { name: 'mcp__remote__lookup', description: 'lookup', category: 'mcp_skill' as const,
      inputSchema: { type: 'object' }, isReadOnly: false, call }
    const state = createManagerToolFaceState()
    const deps = makeDeps({ faceState: state, candidatePermissions: permissions, externalMcpTools: [external], authorizeExternalMcpTool: async () => true })
    const names: string[][] = []
    const turns: EngineTurnEvent[] = []
    const adapter: LLMAdapter = {
      async *stream(params) {
        names.push(params.tools.map((tool) => tool.name))
        if (names.length === 1) yield* chunksFromContent([
          { type: 'tool_use', id: 'search', name: loader, input: loader === 'search_tools' ? { query: external.name, limit: 1 } : { family: 'mcp__remote' } },
          { type: 'tool_use', id: 'too-early', name: external.name, input: {} },
        ], 'tool_use')
        else if (names.length === 2) yield* chunksFromContent([{ type: 'tool_use', id: 'allowed', name: external.name, input: {} }], 'tool_use')
        else yield* chunksFromContent([{ type: 'text', text: 'done' }], 'end_turn')
      },
      updateConfig() {},
    }
    const result = await runEngine({
      prompt: 'lookup', adapter,
      options: {
        model: 'test', systemPrompt: 'test', maxTurns: 3, tools: () => buildManagerToolFace(deps),
        onTurn: (turn) => { turns.push(turn) },
        unavailableToolResult: (name) => ({ output: state.catalog!.missingToolOutput(name), isError: true }),
      },
    })
    expect(result.outcome).toBe('completed')
    expect(turns[0].toolCalls[1]).toMatchObject({ output: expect.stringContaining('TOOL_NOT_LOADED'), isError: true })
    expect(names[0]).toEqual([...NORMAL_MANAGER_CORE_NAMES])
    expect(names[1]).toEqual([...NORMAL_MANAGER_CORE_NAMES, external.name])
    expect(names[2]).toEqual(names[1])
    expect(call).toHaveBeenCalledOnce()
    expect(buildManagerToolFace({ ...deps, faceState: createManagerToolFaceState() }).map((tool) => tool.name)).toEqual(names[0])
  })

  it('外部 MCP 先按最低类别权限过滤，拒绝不安全 metadata，忽略只读 annotation', async () => {
    const external = { name: 'mcp__remote__lookup', description: 'remote', category: 'mcp_skill' as const,
      inputSchema: { type: 'object' }, isReadOnly: true, call: vi.fn(async () => ({ output: 'ok', isError: false })) }
    const state = createManagerToolFaceState()
    const deps = makeDeps({ faceState: state, candidatePermissions: permissions, externalMcpTools: [
      external,
      { ...external, name: 'mcp__remote__unsafe_description', description: 'unsafe\u0000description' },
      { ...external, name: 'mcp__remote__unsafe_schema', inputSchema: { type: 'object', properties: { p: { type: 'string', description: 'unsafe\u001b' } } } },
      { ...external, name: 'mcp__remote__large_schema', inputSchema: { type: 'object', description: 'x'.repeat(66 * 1024) } },
    ], authorizeExternalMcpTool: async () => true })
    const first = buildManagerToolFace(deps)
    await first[0].call({ query: external.name, limit: 1 }, {})
    expect(buildManagerToolFace(deps).find((tool) => tool.name === external.name)?.isReadOnly).toBe(false)
    for (const name of ['mcp__remote__unsafe_description', 'mcp__remote__unsafe_schema', 'mcp__remote__large_schema']) {
      expect(state.catalog!.missingToolOutput(name)).toBe('TOOL_UNAVAILABLE')
    }
    const restricted = createManagerToolFaceState()
    buildManagerToolFace({ ...deps, faceState: restricted, candidatePermissions: { ...permissions, tool_access: { ...permissions.tool_access, mcp_skill: false } } })
    expect(restricted.catalog!.missingToolOutput(external.name)).toBe('TOOL_UNAVAILABLE')
    expect(restricted.catalog!.search(restricted, external.name, 3).loaded).not.toContain(external.name)
  })

  it('检索异常不展开任何能力，无匹配不降级；专用 profile 不暴露外部 MCP', async () => {
    const state = createManagerToolFaceState()
    const deps = makeDeps({ faceState: state, candidatePermissions: permissions })
    const search = buildManagerToolFace(deps)[0]
    expect(JSON.parse((await search.call({ query: 'unmatchedtoken' }, {})).output).status).toBe('no_match')
    expect(buildManagerToolFace(deps)).toHaveLength(NORMAL_MANAGER_CORE_NAMES.length)
    const spy = vi.spyOn(state.catalog!, 'search').mockImplementationOnce(() => { throw new Error('index failed') })
    const failed = await search.call({ query: 'anything' }, {})
    expect(failed.isError).toBe(true)
    expect(JSON.parse(failed.output).status).toBe('degraded')
    expect(buildManagerToolFace(deps).every((tool) => !tool.name.startsWith('mcp__') || tool.name.startsWith('mcp__crab-memory__'))).toBe(true)
    spy.mockRestore()
    for (const [profile, names] of [['daily_reflection', DAILY_REFLECTION_CORE_NAMES], ['memory_graph_rebuild', MEMORY_GRAPH_REBUILD_CORE_NAMES]] as const) {
      const face = buildManagerToolFace(makeDeps({ profile, isBuiltinDailyReflection: profile === 'daily_reflection', faceState: createManagerToolFaceState() }))
      expect(face.map((tool) => tool.name)).toEqual([...names])
    }
  })

  it.each([false, true])('检索故障保留原工具面，恢复后仍只追加；已有 MCP: %s', async (preloadMcp) => {
    const state = createManagerToolFaceState()
    const external = ['before', 'after'].map((name) => ({
      name: `mcp__remote__${name}`, description: name, category: 'mcp_skill' as const,
      inputSchema: { type: 'object' }, isReadOnly: false,
      call: vi.fn(async () => ({ output: 'ok', isError: false })),
    }))
    const deps = makeDeps({ faceState: state, candidatePermissions: permissions,
      externalMcpTools: external, authorizeExternalMcpTool: async () => true })
    const search = buildManagerToolFace(deps)[0]
    if (preloadMcp) await search.call({ query: external[0].name, limit: 1 }, {})
    const before = buildManagerToolFace(deps)

    const spy = vi.spyOn(state.catalog!, 'search').mockImplementationOnce(() => { throw new Error('index failed') })
    const failed = await search.call({ query: 'anything' }, {})
    expect(failed.isError).toBe(true)
    expect(JSON.parse(failed.output).status).toBe('degraded')
    spy.mockRestore()
    const fallback = buildManagerToolFace(deps)
    expect(fallback.slice(0, before.length)).toEqual(before)
    expect(fallback).toEqual(before)
    expect(fallback.some((tool) => tool.name === 'inspect_crabot')).toBe(false)
    expect(fallback.filter((tool) => tool.name.startsWith('mcp__remote__')).map((tool) => tool.name))
      .toEqual(preloadMcp ? [external[0].name] : [])

    const result = JSON.parse((await search.call({ query: external[1].name, limit: 1 }, {})).output)
    expect(result).toMatchObject({ status: 'loaded', loaded: [external[1].name] })
    const recovered = buildManagerToolFace(deps)
    expect(recovered.slice(0, fallback.length)).toEqual(fallback)
    expect(recovered.at(-1)?.name).toBe(external[1].name)
    expect(JSON.parse((await search.call({ query: 'inspect_crabot', limit: 1 }, {})).output))
      .toMatchObject({ status: 'no_match', loaded: [], already_visible: [] })
    expect(new Set(recovered.map((tool) => tool.name)).size).toBe(recovered.length)
    for (const tool of external) expect(tool.call).not.toHaveBeenCalled()
  })

  it('未启用渐进加载时提供完整 56 项，不装配 search_tools 或外部 MCP', () => {
    const tools = buildManagerToolFace(makeDeps({ schedule: {
      targetSession: { channel_id: 'ch-1', session_id: 'sess-1', type: 'private' },
      creatorFriendId: 'creator', canCreate: true, resolvePermissions: async () => null,
    } }))
    expect(tools).toHaveLength(56)
    expect(tools.map(tool => tool.name).filter(name => name.startsWith('mcp__') && !name.startsWith('mcp__crab-memory__'))).toEqual([])
    for (const name of ['search_tools', 'get_system_status', 'get_deployment_info', 'get_config_summary', 'list_capabilities']) {
      expect(tools.map(tool => tool.name)).not.toContain(name)
    }
    for (const name of ['inspect_crabot', 'create_schedule', 'get_schedule', 'list_schedules', 'update_schedule', 'delete_schedule', 'trigger_schedule', 'send_private_message']) {
      expect(tools.map(tool => tool.name)).toContain(name)
    }
  })

  it('普通 manager 工具名集合精确匹配预期清单', () => {
    const tools = buildManagerToolFace(makeDeps())
    const names = tools.map((t) => t.name)
    const nonMemoryNames = names.filter((n) => !n.startsWith('mcp__crab-memory__'))

    expect(nonMemoryNames.sort()).toEqual(
      [...MESSAGING_NORMAL, ...WORKER_TOOLS, ...CONTEXT_TOOLS, ...CRABOT_INFO_TOOLS].sort(),
    )
    expect(memoryToolNames(tools).sort()).toEqual(
      CRAB_MEMORY_MANAGER_TOOL_NAMES.map((name) => `mcp__crab-memory__${name}`).sort(),
    )
    expect(memoryToolNames(tools)).not.toContain('mcp__crab-memory__run_maintenance')
    // 投递类：send_private_message 在（§1 表「普通 manager = 是」），系统线程专属的不在
    expect(names).toContain('send_private_message')
    expect(names).not.toContain('send_master_private')
    // 没有飞书 channel 实例（enableFeishuDocTool falsy）→ §2.10 那一组一个都不出现
    for (const name of [...FEISHU_READ_ONLY_TOOLS, 'feishu_write']) {
      expect(names, `无飞书实例时不应出现 ${name}`).not.toContain(name)
    }
  })

  it('系统线程只多出 send_master_private，其余相同', () => {
    const normalNames = buildManagerToolFace(makeDeps({ isSystemThread: false })).map((t) => t.name).sort()
    const systemNames = buildManagerToolFace(makeDeps({ isSystemThread: true })).map((t) => t.name).sort()

    expect(systemNames).toEqual([...normalNames, 'send_master_private'].sort())
  })

  it('builtin daily reflection 只暴露固定 Admin Web 摘要动作，并登记成功投递的固定目标', async () => {
    const call = vi.fn(async () => ({
      platform_message_id: 'pm-daily',
      sent_at: '2026-08-21T02:00:00.000Z',
    }))
    const onObservedSessionTargets = vi.fn()
    const tools = buildManagerToolFace(makeDeps({
      isSystemThread: true,
      isBuiltinDailyReflection: true,
      onObservedSessionTargets,
      messagingDeps: makeMessagingDeps({
        rpcClient: { call } as never,
        resolveChannelPort: async (channelId: string) => channelId === 'admin-web' ? 19001 : 19009,
      }),
    }))
    const names = tools.map((tool) => tool.name)

    expect(names).toContain('send_daily_reflection_summary')
    expect(names).toContain('send_message')
    for (const forbidden of [
      'send_private_message', 'send_master_private', 'lookup_friend',
      'list_sessions', 'list_contacts', 'list_groups', 'list_group_members', 'fetch_media',
    ]) {
      expect(names).not.toContain(forbidden)
    }

    const summary = tools.find((tool) => tool.name === 'send_daily_reflection_summary')!
    const schema = summary.inputSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(schema.properties ?? {})).toEqual(['content'])

    const result = await summary.call({ content: '今日无重大变化。' }, {} as never)
    expect(result.isError).toBe(false)
    expect(call).toHaveBeenCalledWith(
      19001,
      'send_message',
      {
        session_id: 'system-tasks',
        content: { type: 'text', text: '今日无重大变化。' },
      },
      'manager-test',
    )
    expect(onObservedSessionTargets).toHaveBeenCalledWith([
      { channel_id: 'admin-web', session_id: 'system-tasks' },
    ])
    expect(result.output).not.toContain('observedSessionTargets')
  })

  it('builtin daily reflection 的观察回调失败不改变原工具结果', async () => {
    const call = vi.fn(async () => ({
      platform_message_id: 'pm-daily',
      sent_at: '2026-08-21T02:00:00.000Z',
    }))
    const onObservedSessionTargets = vi.fn(() => { throw new Error('index unavailable') })
    const summary = buildManagerToolFace(makeDeps({
      isSystemThread: true,
      isBuiltinDailyReflection: true,
      onObservedSessionTargets,
      messagingDeps: makeMessagingDeps({ rpcClient: { call } as never }),
    })).find((tool) => tool.name === 'send_daily_reflection_summary')!

    const result = await summary.call({ content: '今日无重大变化。' }, {} as never)

    expect(result).toEqual({
      output: JSON.stringify({
        platform_message_id: 'pm-daily',
        sent_at: '2026-08-21T02:00:00.000Z',
      }),
      isError: false,
    })
    expect(onObservedSessionTargets).toHaveBeenCalledOnce()
  })

  it('存在飞书 channel 实例时：两类 manager 都多出 §2.10 只读三件套，都不含 feishu_write', () => {
    for (const isSystemThread of [false, true]) {
      const tools = buildManagerToolFace(makeDeps({
        isSystemThread,
        messagingDeps: makeMessagingDeps({ enableFeishuDocTool: true }),
      }))
      const names = tools.map((t) => t.name)
      const nonMemoryNames = names.filter((n) => !n.startsWith('mcp__crab-memory__'))

      expect(nonMemoryNames.sort(), `isSystemThread=${isSystemThread}`).toEqual(
        [
          ...MESSAGING_NORMAL,
          ...FEISHU_READ_ONLY_TOOLS,
          ...(isSystemThread ? ['send_master_private'] : []),
          ...WORKER_TOOLS,
          ...CONTEXT_TOOLS,
          ...CRABOT_INFO_TOOLS,
        ].sort(),
      )
      // 任意写 API 透传绝不进 manager 工具面（protocol-crab-messaging.md §1 note）
      expect(names, `isSystemThread=${isSystemThread} 不得含 feishu_write`).not.toContain('feishu_write')
    }
  })

  it('isReadOnly 标记正确', () => {
    const tools = buildManagerToolFace(makeDeps({
      isSystemThread: true,
      messagingDeps: makeMessagingDeps({ enableFeishuDocTool: true }),
    }))
    const byName = new Map(tools.map((t) => [t.name, t]))

    const readOnly = ['get_history', 'get_message', 'lookup_friend', 'list_sessions', 'list_contacts', 'list_groups', 'list_group_members', 'fetch_media', ...FEISHU_READ_ONLY_TOOLS, 'get_worker_state', 'get_worker_activity', 'get_worker_turn', 'get_worker_terminal', 'list_workers', 'inspect_workboard', 'inspect_project_docs', ...CRABOT_INFO_TOOLS]
    for (const name of readOnly) {
      expect(byName.get(name)?.isReadOnly, `${name} 应为 isReadOnly:true`).toBe(true)
    }

    const writeTools = ['send_message', 'send_master_private', 'send_private_message', 'spawn_worker', 'send_to_worker', 'query_worker', 'resolve_worker_turn', 'request_worker_interrupt', 'request_worker_stop', 'respond_to_worker_ui', 'change_workboard']
    for (const name of writeTools) {
      expect(byName.get(name)?.isReadOnly, `${name} 应为 isReadOnly:false`).toBe(false)
    }
  })

  it('三个投递工具的 inputSchema 都要求声明 post_send_action', () => {
    const tools = buildManagerToolFace(makeDeps({ isSystemThread: true }))

    for (const name of ['send_message', 'send_private_message', 'send_master_private']) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as {
        properties?: Record<string, unknown>
        required?: string[]
      }
      expect(schema.properties?.post_send_action, `${name} 应暴露 post_send_action`).toBeDefined()
      expect(schema.required, `${name} 应要求声明 post_send_action`).toContain('post_send_action')
    }
  })

  it.each(['full', 'progressive'] as const)('%s 的 send_message 说明与 Manager 无 intent 的接口一致', (mode) => {
    const tools = buildManagerToolFace(makeDeps({ faceState: createManagerToolFaceState(mode) }))
    const sendMessage = tools.find((tool) => tool.name === 'send_message')!
    expect(sendMessage.description).not.toMatch(/intent|ask_human|waiting_human|forced.summary|audit|engine 不让我 end_turn/)
    expect(sendMessage.description).toContain('普通 assistant text')
    expect(sendMessage.description).toContain('结束本回合')
    expect(sendMessage.description).toContain('不重复发送')
  })

  it('send_message 的 inputSchema 不含 intent，成功 spawn_worker 声明触发回调且不透传字段', async () => {
    const onPostSendAction = vi.fn()
    const onSuccessfulSendMessage = vi.fn()
    const rpcCall = vi.fn(async (_port: number, method: string) => {
      if (method === 'send_message') {
        return { platform_message_id: 'm1', sent_at: '2026-08-01T00:00:00.000Z' }
      }
      throw new Error(`未预期的 RPC: ${method}`)
    })
    const deps = makeDeps({
      onPostSendAction,
      onSuccessfulSendMessage,
      messagingDeps: {
        rpcClient: {
          call: rpcCall,
        } as never,
        moduleId: 'manager-test',
        getAdminPort: async () => 19001,
        resolveChannelPort: async () => 19009,
      },
    })
    const tools = buildManagerToolFace(deps)
    const sendMessage = tools.find((t) => t.name === 'send_message')!

    const schema = sendMessage.inputSchema as { properties?: Record<string, unknown> }
    expect(schema.properties).toBeDefined()
    expect(Object.keys(schema.properties!)).not.toContain('intent')
    expect(Object.keys(schema.properties!)).toContain('post_send_action')

    const result = await sendMessage.call(
      { channel_id: 'ch-1', session_id: 'sess-1', content: 'hi', intent: 'ask_human', post_send_action: 'spawn_worker' },
      {} as never,
    )
    expect(result.isError).toBe(false)
    expect(onPostSendAction).toHaveBeenCalledTimes(1)
    expect(onPostSendAction).toHaveBeenLastCalledWith('spawn_worker')
    expect(onSuccessfulSendMessage).toHaveBeenCalledWith({ channel_id: 'ch-1', session_id: 'sess-1' })
    expect(rpcCall).toHaveBeenCalledWith(
      19009,
      'send_message',
      expect.not.objectContaining({ post_send_action: expect.anything(), intent: expect.anything() }),
      'manager-test',
    )
  })

  it('投递失败时不触发 post_send_action 回调', async () => {
    const onPostSendAction = vi.fn()
    const onSuccessfulSendMessage = vi.fn()
    const tools = buildManagerToolFace(makeDeps({
      onPostSendAction,
      onSuccessfulSendMessage,
      messagingDeps: makeMessagingDeps({ resolveChannelPort: async () => undefined }),
    }))

    const result = await tools.find((tool) => tool.name === 'send_message')!.call(
      { channel_id: 'ch-1', session_id: 'sess-1', content: 'hi', post_send_action: 'spawn_worker' },
      {} as never,
    )

    expect(result.isError).toBe(true)
    expect(onPostSendAction).not.toHaveBeenCalled()
    expect(onSuccessfulSendMessage).not.toHaveBeenCalled()
  })

  it('普通 manager 真调一次 send_private_message：不被 requireDeclaredShortcut 拦，RPC 真的打出去并登记真实目标', async () => {
    const call = vi.fn(async (_port: number, method: string) => {
      switch (method) {
        case 'get_friend':
          return { friend: { display_name: 'Alice', channel_identities: [{ channel_id: 'ch-1', platform_user_id: 'u-1' }] } }
        case 'find_or_create_private_session':
          return { session: { id: 'sess-9' }, created: false }
        case 'send_message':
          return { platform_message_id: 'pm-1', sent_at: '2026-08-01T00:00:00.000Z' }
        default:
          throw new Error(`未预期的 RPC: ${method}`)
      }
    })
    const onObservedSessionTargets = vi.fn()
    const tools = buildManagerToolFace(makeDeps({
      isSystemThread: false,
      onObservedSessionTargets,
      messagingDeps: makeMessagingDeps({ rpcClient: { call } as never }),
    }))
    const sendPrivate = tools.find((t) => t.name === 'send_private_message')!

    const result = await sendPrivate.call({ friend_id: 'f-1', content: 'hi', post_send_action: 'none' }, {} as never)

    // 运行时门若拒绝，会返回 isError + SCHEDULED_ONLY_TOOL 且**零 RPC**——这两条一起钉住
    // 「可见性门与运行时门同源」，而不只是「工具出现在列表里」。
    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('SCHEDULED_ONLY_TOOL')
    expect(JSON.parse(result.output)).toMatchObject({ channel_id: 'ch-1', session_id: 'sess-9', platform_message_id: 'pm-1' })
    expect(onObservedSessionTargets).toHaveBeenCalledWith([
      { channel_id: 'ch-1', session_id: 'sess-9' },
    ])
    expect(call.mock.calls.map((c) => c[1])).toEqual(['get_friend', 'find_or_create_private_session', 'send_message'])
  })

  it('护栏拦截注入的通用文件系统工具（bash/read/write/edit/glob/grep/delegate_task）', () => {
    const banned: ToolDefinition = {
      name: 'bash',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: false,
      call: async () => ({ output: '', isError: false }),
    }
    expect(() => assertClosedToolFace([banned])).toThrow()
  })

  it('护栏拦截外装 mcp__ 工具，但放行 mcp__crab-memory__ 前缀', () => {
    const foreignMcp: ToolDefinition = {
      name: 'mcp__some-other-server__do_thing',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: false,
      call: async () => ({ output: '', isError: false }),
    }
    expect(() => assertClosedToolFace([foreignMcp])).toThrow()

    const memoryTool: ToolDefinition = {
      name: 'mcp__crab-memory__search_memory',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: false,
      call: async () => ({ output: '', isError: false }),
    }
    expect(() => assertClosedToolFace([memoryTool])).not.toThrow()
  })

  it('crab-memory server 多注册协议外工具时 fail-loud，不原样暴露给 Manager', () => {
    const memoryServer = makeMemoryServer()
    memoryServer.registerTool(
      'run_maintenance',
      { description: 'not an LLM tool', inputSchema: {} },
      async () => ({ content: [{ type: 'text' as const, text: '{}' }] }),
    )

    expect(() => buildManagerToolFace(makeDeps({ memoryServer }))).toThrow(
      /unexpected=mcp__crab-memory__run_maintenance/,
    )
  })

  it('装配结果本身通过护栏（buildManagerToolFace 不抛错）', () => {
    expect(() => buildManagerToolFace(makeDeps({ isSystemThread: true }))).not.toThrow()
  })

  describe('send_message 参数修复（spec 2026-09-03-tool-input-repair）', () => {
    it('send_message 携带 repairInput，省略 channel_id 时只查当前 Manager 已登记归属', async () => {
      const lookup = vi.fn((sessionId: string) =>
        sessionId === 'sess-9' ? new Set(['ch-2']) : undefined
      )
      const tools = buildManagerToolFace(makeDeps({
        managerTarget: { channel_id: 'ch-1', session_id: 'sess-1' },
        sessionChannelsFor: lookup,
      }))
      const send = tools.find((t) => t.name === 'send_message')
      expect(send?.repairInput).toBeTypeOf('function')
      const repaired = await send!.repairInput!({ session_id: 'sess-9', content: 'x' })
      expect(repaired).toEqual({ channel_id: 'ch-2', session_id: 'sess-9', content: 'x' })
      expect(lookup).toHaveBeenCalledOnce()
      expect(lookup).toHaveBeenCalledWith('sess-9')
    })

    it('零命中时原对象透传；repairInput 只挂在 send_message 上', async () => {
      const tools = buildManagerToolFace(makeDeps({
        managerTarget: { channel_id: 'ch-1', session_id: 'sess-1' },
        sessionChannelsFor: () => undefined,
      }))
      const send = tools.find((t) => t.name === 'send_message')!
      const input = { session_id: 'no-such', content: 'x' }
      expect(await send.repairInput!(input)).toBe(input)
      for (const tool of tools) {
        if (tool.name !== 'send_message') expect(tool.repairInput, tool.name).toBeUndefined()
      }
    })

    it('仅 Manager schema 允许省略 channel_id，raw messaging schema 仍要求该字段', () => {
      const tools = buildManagerToolFace(makeDeps())
      const send = tools.find((tool) => tool.name === 'send_message')!
      const schema = send.inputSchema as { required?: string[] }
      expect(schema.required).toContain('session_id')
      expect(schema.required).not.toContain('channel_id')

      const rawServer = createCrabMessagingServer(makeMessagingDeps())
      const raw = mcpServerToToolDefinitions(rawServer, 'crab-messaging')
        .find((tool) => tool.name === 'mcp__crab-messaging__send_message')!
      expect((raw.inputSchema as { required?: string[] }).required).toContain('channel_id')
      expect(raw.repairInput).toBeUndefined()
    })

    it('engine 真实调用链使用 repaired target，不扫描 Channel，也不改写原工具返回', async () => {
      const call = vi.fn(async (_port: number, method: string) => {
        if (method === 'send_message') {
          return { platform_message_id: 'pm-1', sent_at: '2026-09-05T00:00:00.000Z' }
        }
        throw new Error(`未预期的 RPC: ${method}`)
      })
      const onSuccessfulSendMessage = vi.fn()
      const onObservedSessionTargets = vi.fn()
      const tools = buildManagerToolFace(makeDeps({
        managerTarget: { channel_id: 'ch-1', session_id: 'sess-1' },
        sessionChannelsFor: () => new Set(['ch-2']),
        onSuccessfulSendMessage,
        onObservedSessionTargets,
        messagingDeps: makeMessagingDeps({
          rpcClient: { call } as never,
          resolveChannelPort: async (channelId) => channelId === 'ch-2' ? 19002 : 0,
        }),
      }))

      const [result] = await executeToolBatches(
        [{ parallel: false, blocks: [{
          id: 'send-1',
          name: 'send_message',
          input: { session_id: 'sess-9', content: 'hi', post_send_action: 'none' },
        }] }],
        tools,
      )

      expect(result.is_error).toBe(false)
      expect(JSON.parse(result.content.slice(result.content.indexOf('\n') + 1))).toEqual({
        platform_message_id: 'pm-1',
        sent_at: '2026-09-05T00:00:00.000Z',
      })
      expect(result.content).not.toContain('observedSessionTargets')
      expect(call.mock.calls.map((entry) => entry[1])).toEqual(['send_message'])
      expect(call).toHaveBeenCalledWith(
        19002,
        'send_message',
        expect.objectContaining({ session_id: 'sess-9' }),
        'manager-test',
      )
      expect(onObservedSessionTargets).toHaveBeenCalledWith([
        { channel_id: 'ch-2', session_id: 'sess-9' },
      ])
      expect(onSuccessfulSendMessage).toHaveBeenCalledWith({ channel_id: 'ch-2', session_id: 'sess-9' })
    })

    it('只消费成功 handler 提供的结构化观察，observer 抛错不改变工具结果', async () => {
      const onObservedSessionTargets = vi.fn(() => { throw new Error('index unavailable') })
      const call = vi.fn(async (_port: number, method: string) => {
        if (method === 'get_sessions') {
          return {
            items: [{ id: 'sess-9', channel_id: 'ch-2', type: 'private' }],
            pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
          }
        }
        throw new Error(`未预期的 RPC: ${method}`)
      })
      const tools = buildManagerToolFace(makeDeps({
        onObservedSessionTargets,
        messagingDeps: makeMessagingDeps({ rpcClient: { call } as never }),
      }))
      const listSessions = tools.find((tool) => tool.name === 'list_sessions')!

      const result = await listSessions.call({ channel_id: 'ch-2' }, {} as never)

      expect(result.isError).toBe(false)
      expect(JSON.parse(result.output)).toMatchObject({
        items: [{ id: 'sess-9', channel_id: 'ch-2' }],
      })
      expect(result.output).not.toContain('observedSessionTargets')
      expect(onObservedSessionTargets).toHaveBeenCalledWith([
        { channel_id: 'ch-2', session_id: 'sess-9' },
      ])
    })

    it('失败的目标操作不登记模型提供的 pair', async () => {
      const onObservedSessionTargets = vi.fn()
      const tools = buildManagerToolFace(makeDeps({
        onObservedSessionTargets,
        messagingDeps: makeMessagingDeps({
          rpcClient: { call: vi.fn(async () => { throw new Error('channel down') }) } as never,
        }),
      }))

      const result = await tools.find((tool) => tool.name === 'get_message')!.call({
        channel_id: 'ch-2',
        session_id: 'sess-untrusted',
        platform_message_id: 'pm-1',
      }, {} as never)

      expect(result.isError).toBe(false)
      expect(JSON.parse(result.output)).toMatchObject({ error: expect.stringContaining('channel down') })
      expect(onObservedSessionTargets).not.toHaveBeenCalled()
    })
  })
})
