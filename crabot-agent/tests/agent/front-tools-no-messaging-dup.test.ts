/**
 * 防漂移测试：Front 工具集不再独立声明 messaging 工具，必须从 crab-messaging MCP 派生。
 *
 * 历史教训：曾经 Front 在 front-tools.ts 重复声明了一套 messaging 工具
 * （lookup_friend / list_contacts / list_groups / list_sessions / open_private_session /
 * send_message / get_history / get_message），与 Worker 的 crab-messaging MCP 各自维护，
 * 导致 Worker MCP 新增 send_private_message 后 Front 漏同步、open_private_session
 * 在 Worker 端早被替代后 Front 仍暴露给 LLM。本测试在装配阶段拦住这类漂移。
 */
import { describe, it, expect } from 'vitest'
import { getAllFrontTools } from '../../src/agent/front-tools.js'
import { mcpServerToToolDefinitions } from '../../src/agent/mcp-tool-bridge.js'
import { createCrabMessagingServer } from '../../src/mcp/crab-messaging.js'

/** 只在 crab-messaging MCP 中实现、Front 不允许独立重复声明的工具名。 */
const MESSAGING_TOOL_NAMES_BANNED_AS_FRONT_PRIVATE = [
  'lookup_friend',
  'list_contacts',
  'list_groups',
  'list_sessions',
  'open_private_session',
  'send_message',
  'send_private_message',
  'get_history',
  'get_message',
] as const

function buildMessagingTools() {
  const server = createCrabMessagingServer({
    rpcClient: {} as never,
    moduleId: 'test',
    getAdminPort: async () => 1,
    resolveChannelPort: async () => 2,
  })
  return mcpServerToToolDefinitions(server, 'crab-messaging')
}

describe('Front tools — messaging single-source-of-truth', () => {
  it('Front 私有工具列表不重复声明任何 messaging 工具（无 messagingTools 注入时）', () => {
    const frontPrivate = getAllFrontTools(false, [], [])
    const names = frontPrivate.map(t => t.name)
    for (const banned of MESSAGING_TOOL_NAMES_BANNED_AS_FRONT_PRIVATE) {
      expect(
        names,
        `Front 私有工具集不应包含 "${banned}"——该工具应由 crab-messaging MCP 单一来源提供。如果你刚加了一个 messaging 工具到 front-tools.ts，请挪到 src/mcp/crab-messaging.ts。`,
      ).not.toContain(banned)
    }
  })

  it('messaging 工具来自 crab-messaging MCP，工具名带 mcp__crab-messaging__ 前缀', () => {
    const messagingTools = buildMessagingTools()
    expect(messagingTools.length).toBeGreaterThan(0)
    for (const tool of messagingTools) {
      expect(
        tool.name,
        `MCP 派生工具应带 mcp__<server>__ 前缀，实际: ${tool.name}`,
      ).toMatch(/^mcp__crab-messaging__/)
    }
  })

  it('crab-messaging MCP 必须提供 send_private_message（替代 open_private_session 的封装入口）', () => {
    const messagingTools = buildMessagingTools()
    const names = messagingTools.map(t => t.name)
    expect(names).toContain('mcp__crab-messaging__send_private_message')
  })

  it('crab-messaging MCP 不应再提供 open_private_session（已被 send_private_message 取代）', () => {
    // 防止有人之后想"补全"对称性把 open_private_session 加回 MCP。新增 messaging 工具
    // 应优先选"程序自动处理 session"的封装风格（如 send_private_message），让 LLM
    // 只描述意图、不操心 session_id。
    const messagingTools = buildMessagingTools()
    const names = messagingTools.map(t => t.name)
    expect(names).not.toContain('mcp__crab-messaging__open_private_session')
  })

  it('Front 完整工具集（注入 messaging 后）= 决策类 + Front 私有 + MCP messaging（带前缀）', () => {
    const messagingTools = buildMessagingTools()
    const allTools = getAllFrontTools(false, [], messagingTools)
    const names = allTools.map(t => t.name)

    // 决策与 Front 私有
    expect(names).toContain('reply')
    expect(names).toContain('create_task')
    expect(names).toContain('query_tasks')
    expect(names).toContain('create_schedule')
    expect(names).toContain('store_memory')

    // Messaging（带前缀）
    expect(names).toContain('mcp__crab-messaging__send_private_message')

    // 没有未带前缀的 messaging 工具混入
    for (const banned of MESSAGING_TOOL_NAMES_BANNED_AS_FRONT_PRIVATE) {
      expect(names).not.toContain(banned)
    }
  })
})
