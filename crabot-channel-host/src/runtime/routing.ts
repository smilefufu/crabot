/**
 * runtime/routing.ts - Agent 路由（固定使用默认 Agent）
 *
 * Crabot 只有一个 Agent，所以路由始终返回默认值。
 * 返回结构需要与 OpenClaw 的 ResolvedAgentRoute 接口兼容：
 *   { agentId, channel, accountId, sessionKey, mainSessionKey, matchedBy }
 */

interface ResolveAgentRouteParams {
  cfg?: unknown
  channel?: string
  accountId?: string
  peer?: { kind: string; id: string }
  parentPeer?: unknown
}

export const routingRuntime = {
  resolveAgentRoute: (params?: ResolveAgentRouteParams) => {
    const channel = params?.channel ?? 'unknown'
    const accountId = params?.accountId ?? 'default'
    const peerId = params?.peer?.id ?? 'unknown'
    const peerKind = params?.peer?.kind === 'group' ? 'group' : 'dm'
    const sessionKey = `agent:main:${channel}:${peerKind}:${peerId}`

    return {
      agentId: 'main',
      channel,
      accountId,
      sessionKey,
      mainSessionKey: 'agent:main:main',
      matchedBy: 'default' as const,
    }
  },
}
