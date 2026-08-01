import { describe, it, expect, vi } from 'vitest'
import { RpcCallError } from 'crabot-shared'

// MCP server.tool 注册的 handler 没法直接外部调用。我们用一个轻量 helper：
// 改用 buildWorkerMessagingTools 纯函数（实现一并 export）来测试。
// 这要求实现侧把工具构造从 server.tool 注入流程里抽出来。
import { buildWorkerMessagingTools } from '../../src/mcp/crab-messaging.js'

type MockRpcClient = { call: ReturnType<typeof vi.fn> }

type TestDeps = {
  rpcClient: MockRpcClient
  moduleId: string
  getAdminPort: () => Promise<number>
  resolveChannelPort: (id: string) => Promise<number>
}

function makeDeps(): TestDeps {
  return {
    rpcClient: { call: vi.fn() },
    moduleId: 'agent-test',
    getAdminPort: async () => 0,
    resolveChannelPort: async () => 12345,
  }
}

function findTool(tools: ReturnType<typeof buildWorkerMessagingTools>, name: string) {
  const t = tools.find((x: (typeof tools)[number]) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

function parseToolResult(out: unknown): Record<string, unknown> {
  return JSON.parse((out as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>
}

describe('crab-messaging list_groups 工具', () => {
  it('成功：路由到 channelPort.list_groups 并返回带分页元信息的结果', async () => {
    const deps = makeDeps()
    deps.rpcClient.call = vi.fn().mockResolvedValue({
      items: [{ platform_session_id: '12345@chatroom', group_name: '工作群' }],
      pagination: { page: 1, page_size: 50, total_items: 187, total_pages: 4 },
    })

    const tools = buildWorkerMessagingTools(deps as never)
    const out = await findTool(tools, 'list_groups').handler({ channel_id: 'wechat-x', search: '工作' })

    expect(deps.rpcClient.call).toHaveBeenCalledWith(
      12345,
      'list_groups',
      expect.objectContaining({ search: '工作', pagination: { page: 1, page_size: 50 } }),
      'agent-test',
    )
    const parsed = parseToolResult(out)
    expect(parsed.pagination).toMatchObject({
      has_more: true,
      is_truncated: true,
      default_page_size_applied: true,
      next_page: 2,
    })
  })

  it('CHANNEL_LIST_GROUPS_NOT_SUPPORTED → 返回结构化错误带 hint', async () => {
    const deps = makeDeps()
    deps.rpcClient.call = vi.fn().mockRejectedValue(
      new RpcCallError('CHANNEL_LIST_GROUPS_NOT_SUPPORTED', 'tg 不支持'),
    )
    const tools = buildWorkerMessagingTools(deps as never)
    const out = await findTool(tools, 'list_groups').handler({ channel_id: 'tg-x' })
    const parsed = parseToolResult(out)
    expect(parsed.error_code).toBe('CHANNEL_LIST_GROUPS_NOT_SUPPORTED')
    expect(parsed.hint).toContain('list_sessions')
  })

  it('LLM 显式传 page_size 时 default_page_size_applied=false', async () => {
    const deps = makeDeps()
    deps.rpcClient.call = vi.fn().mockResolvedValue({
      items: [],
      pagination: { page: 1, page_size: 100, total_items: 200, total_pages: 2 },
    })
    const tools = buildWorkerMessagingTools(deps as never)
    const out = await findTool(tools, 'list_groups').handler({ channel_id: 'wechat-x', page_size: 100 })
    const parsed = parseToolResult(out)
    expect(parsed.pagination).toMatchObject({ default_page_size_applied: false, page_size: 100 })
  })
})

describe('crab-messaging list_contacts 工具', () => {
  it('PERMISSION_DENIED → 透传 missing_scope', async () => {
    const deps = makeDeps()
    deps.rpcClient.call = vi.fn().mockRejectedValue(
      new RpcCallError('PERMISSION_DENIED', '缺 scope', { missing_scope: 'contact:user.base:readonly' }),
    )
    const tools = buildWorkerMessagingTools(deps as never)
    const out = await findTool(tools, 'list_contacts').handler({ channel_id: 'feishu-x' })
    const parsed = parseToolResult(out)
    expect(parsed.error_code).toBe('PERMISSION_DENIED')
    expect(parsed.missing_scope).toBe('contact:user.base:readonly')
  })

  it('成功：路由到 channelPort.list_contacts 并返回分页元信息', async () => {
    const deps = makeDeps()
    deps.rpcClient.call = vi.fn().mockResolvedValue({
      items: [{ platform_user_id: 'wxid_a', display_name: '老李' }],
      pagination: { page: 1, page_size: 50, total_items: 1, total_pages: 1 },
    })
    const tools = buildWorkerMessagingTools(deps as never)
    const out = await findTool(tools, 'list_contacts').handler({ channel_id: 'wechat-x' })
    const parsed = parseToolResult(out)
    expect(parsed.pagination).toMatchObject({ has_more: false, next_page: null })
  })
})

describe('crab-messaging list_sessions 工具', () => {
  it('返回也带分页元信息', async () => {
    const deps = makeDeps()
    deps.rpcClient.call = vi.fn().mockResolvedValue({
      items: [{ session_id: 's1', type: 'group', title: 'X', participant_count: 5 }],
      pagination: { page: 1, page_size: 20, total_items: 80, total_pages: 4 },
    })
    const tools = buildWorkerMessagingTools(deps as never)
    const out = await findTool(tools, 'list_sessions').handler({ channel_id: 'wechat-x' })
    const parsed = parseToolResult(out)
    expect(parsed.pagination).toMatchObject({ has_more: true, next_page: 2 })
  })
})
