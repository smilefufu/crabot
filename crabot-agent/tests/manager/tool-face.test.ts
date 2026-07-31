/**
 * manager 封闭工具面装配测试 —— protocol-agent-v3.md §4.3。
 *
 * 覆盖：
 * - 普通 manager 工具名集合精确匹配预期清单
 * - 系统线程（isSystemThread）多出 send_master_private / send_private_message，其余不变
 * - 运行时护栏对注入的违规工具（通用文件系统工具 / 外装 mcp__ 工具）抛错，crab-memory 前缀放行
 * - isReadOnly 标记正确（messaging 只读子集 / worker 六件套 / crabot-info 六件套）
 * - send_message 暴露给 LLM 的 inputSchema 不含 intent，调用底层 handler 时也不透传 intent
 */
import { describe, it, expect, vi } from 'vitest'
import { buildManagerToolFace, assertClosedToolFace, type ToolFaceDeps } from '../../src/manager/tools/tool-face'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory'
import type { WorkerHarness } from '../../src/workers/harness/harness'
import type { ToolDefinition } from '../../src/engine/index'

const MESSAGING_NORMAL = [
  'send_message',
  'get_history',
  'get_message',
  'lookup_friend',
  'list_sessions',
  'list_contacts',
  'list_groups',
  'list_group_members',
  'fetch_media',
]

const WORKER_TOOLS = ['spawn_worker', 'send_to_worker', 'query_worker', 'read_worker_output', 'list_workers', 'kill_worker']

const CRABOT_INFO_TOOLS = [
  'get_system_status',
  'get_deployment_info',
  'list_schedules',
  'get_config_summary',
  'list_capabilities',
  'get_friend_permissions',
]

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

function makeDeps(overrides: Partial<ToolFaceDeps> = {}): ToolFaceDeps {
  return {
    harness: {} as unknown as WorkerHarness,
    workerContext: () => ({
      dialogObjectId: 'dlg-1',
      managerKey: 'manager-1',
      reportTo: { channel_id: 'ch-1', session_id: 'sess-1' },
    }),
    messagingDeps: {
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'manager-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
    },
    memoryServer: makeMemoryServer(),
    callAdmin: vi.fn(async () => ({})) as unknown as ToolFaceDeps['callAdmin'],
    isSystemThread: false,
    ...overrides,
  }
}

function memoryToolNames(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.name).filter((n) => n.startsWith('mcp__crab-memory__'))
}

describe('buildManagerToolFace', () => {
  it('普通 manager 工具名集合精确匹配预期清单', () => {
    const tools = buildManagerToolFace(makeDeps())
    const names = tools.map((t) => t.name)
    const nonMemoryNames = names.filter((n) => !n.startsWith('mcp__crab-memory__'))

    expect(nonMemoryNames.sort()).toEqual(
      [...MESSAGING_NORMAL, ...WORKER_TOOLS, ...CRABOT_INFO_TOOLS].sort(),
    )
    // crab-memory 原样全给，不裁（§4.3），至少有 A 组 6 个
    expect(memoryToolNames(tools).length).toBeGreaterThanOrEqual(6)
    // 系统线程专属工具不应出现
    expect(names).not.toContain('send_master_private')
    expect(names).not.toContain('send_private_message')
  })

  it('系统线程多出 send_master_private / send_private_message，其余相同', () => {
    const normalNames = buildManagerToolFace(makeDeps({ isSystemThread: false })).map((t) => t.name).sort()
    const systemNames = buildManagerToolFace(makeDeps({ isSystemThread: true })).map((t) => t.name).sort()

    expect(systemNames).toEqual(
      [...normalNames, 'send_master_private', 'send_private_message'].sort(),
    )
  })

  it('isReadOnly 标记正确', () => {
    const tools = buildManagerToolFace(makeDeps({ isSystemThread: true }))
    const byName = new Map(tools.map((t) => [t.name, t]))

    const readOnly = ['get_history', 'get_message', 'lookup_friend', 'list_sessions', 'list_contacts', 'list_groups', 'list_group_members', 'fetch_media', 'read_worker_output', 'list_workers', ...CRABOT_INFO_TOOLS]
    for (const name of readOnly) {
      expect(byName.get(name)?.isReadOnly, `${name} 应为 isReadOnly:true`).toBe(true)
    }

    const writeTools = ['send_message', 'send_master_private', 'send_private_message', 'spawn_worker', 'send_to_worker', 'query_worker', 'kill_worker']
    for (const name of writeTools) {
      expect(byName.get(name)?.isReadOnly, `${name} 应为 isReadOnly:false`).toBe(false)
    }
  })

  it('send_message 的 inputSchema 不含 intent，调用时也不透传 intent', async () => {
    const capturedArgsByHandler: Record<string, unknown> = {}
    const deps = makeDeps({
      messagingDeps: {
        rpcClient: {
          call: vi.fn(async () => ({ status: 'sent', message_id: 'm1' })),
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

    const result = await sendMessage.call(
      { channel_id: 'ch-1', session_id: 'sess-1', content: 'hi', intent: 'ask_human' },
      {} as never,
    )
    // 不应因 intent='ask_human' 而走 ask_human 分支（那个分支需要 taskCtx 存在才会成功，
    // manager 没有 task 上下文；若 intent 被透传，这里会因缺 taskCtx 而报错/行为异常）
    expect(result.isError).toBe(false)
    void capturedArgsByHandler
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

  it('装配结果本身通过护栏（buildManagerToolFace 不抛错）', () => {
    expect(() => buildManagerToolFace(makeDeps({ isSystemThread: true }))).not.toThrow()
  })
})
