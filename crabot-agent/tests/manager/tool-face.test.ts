/**
 * manager 封闭工具面装配测试 —— protocol-agent-v3.md §4.3。
 *
 * 覆盖：
 * - 普通 manager 工具名集合精确匹配预期清单（含 send_private_message，protocol-crab-messaging §1）
 * - 系统线程（isSystemThread）多出 send_master_private，其余不变
 * - 飞书 channel 存在时多出 §2.10 的只读三件套，且**任何情况下都不含 feishu_write**
 * - 运行时护栏对注入的违规工具（通用文件系统工具 / 外装 mcp__ 工具）抛错，crab-memory 前缀放行
 * - isReadOnly 标记正确（messaging 只读子集 / worker 六件套 / crabot-info 六件套）
 * - 三个投递工具要求声明 post_send_action，调用底层 handler 时不透传该字段
 * - 可见性门与运行时门同源：可见的 send_private_message 真调一次不被 requireDeclaredShortcut 拦
 */
import { describe, it, expect, vi } from 'vitest'
import { buildManagerToolFace, assertClosedToolFace, type ToolFaceDeps } from '../../src/manager/tools/tool-face'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory'
import type { WorkerHarness } from '../../src/workers/harness/harness'
import type { ToolDefinition } from '../../src/engine/index'

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

const WORKER_TOOLS = ['spawn_worker', 'send_to_worker', 'query_worker', 'get_worker_terminal', 'list_workers', 'get_worker_detail', 'list_worker_implementations', 'kill_worker', 'set_worker_periodic_report', 'clear_worker_periodic_report']

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
      managerKey: 'ch-1::sess-1',
      reportTo: { channel_id: 'ch-1', session_id: 'sess-1' },
    }),
    messagingDeps: makeMessagingDeps(),
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

    const readOnly = ['get_history', 'get_message', 'lookup_friend', 'list_sessions', 'list_contacts', 'list_groups', 'list_group_members', 'fetch_media', ...FEISHU_READ_ONLY_TOOLS, 'get_worker_terminal', 'list_workers', ...CRABOT_INFO_TOOLS]
    for (const name of readOnly) {
      expect(byName.get(name)?.isReadOnly, `${name} 应为 isReadOnly:true`).toBe(true)
    }

    const writeTools = ['send_message', 'send_master_private', 'send_private_message', 'spawn_worker', 'send_to_worker', 'query_worker', 'kill_worker', 'set_worker_periodic_report', 'clear_worker_periodic_report']
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

  it('send_message 的 inputSchema 不含 intent，成功 spawn_worker 声明触发回调且不透传字段', async () => {
    const onPostSendAction = vi.fn()
    const rpcCall = vi.fn(async (_port: number, method: string) => {
      if (method === 'send_message') {
        return { platform_message_id: 'm1', sent_at: '2026-08-01T00:00:00.000Z' }
      }
      throw new Error(`未预期的 RPC: ${method}`)
    })
    const deps = makeDeps({
      onPostSendAction,
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
    expect(rpcCall).toHaveBeenCalledWith(
      19009,
      'send_message',
      expect.not.objectContaining({ post_send_action: expect.anything(), intent: expect.anything() }),
      'manager-test',
    )
  })

  it('投递失败时不触发 post_send_action 回调', async () => {
    const onPostSendAction = vi.fn()
    const tools = buildManagerToolFace(makeDeps({
      onPostSendAction,
      messagingDeps: makeMessagingDeps({ resolveChannelPort: async () => undefined }),
    }))

    const result = await tools.find((tool) => tool.name === 'send_message')!.call(
      { channel_id: 'ch-1', session_id: 'sess-1', content: 'hi', post_send_action: 'spawn_worker' },
      {} as never,
    )

    expect(result.isError).toBe(true)
    expect(onPostSendAction).not.toHaveBeenCalled()
  })

  it('普通 manager 真调一次 send_private_message：不被 requireDeclaredShortcut 拦，RPC 真的打出去', async () => {
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
    const tools = buildManagerToolFace(makeDeps({
      isSystemThread: false,
      messagingDeps: makeMessagingDeps({ rpcClient: { call } as never }),
    }))
    const sendPrivate = tools.find((t) => t.name === 'send_private_message')!

    const result = await sendPrivate.call({ friend_id: 'f-1', content: 'hi', post_send_action: 'none' }, {} as never)

    // 运行时门若拒绝，会返回 isError + SCHEDULED_ONLY_TOOL 且**零 RPC**——这两条一起钉住
    // 「可见性门与运行时门同源」，而不只是「工具出现在列表里」。
    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('SCHEDULED_ONLY_TOOL')
    expect(JSON.parse(result.output)).toMatchObject({ channel_id: 'ch-1', session_id: 'sess-9', platform_message_id: 'pm-1' })
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

  it('装配结果本身通过护栏（buildManagerToolFace 不抛错）', () => {
    expect(() => buildManagerToolFace(makeDeps({ isSystemThread: true }))).not.toThrow()
  })
})
