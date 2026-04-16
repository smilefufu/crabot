/**
 * 主动发送支持 — 从 Session 的 platform_session_id 提取平台原生目标 ID
 *
 * OpenClaw 格式的 SessionKey 用 `:` 分隔，最后一段是平台原生 ID：
 *   "agent:main:feishu:dm:ou_39b04af0..." → "ou_39b04af0..."
 *   "agent:main:feishu:group:oc_873c366..." → "oc_873c366..."
 *
 * 非 OpenClaw 格式的（微信等）直接就是平台 ID：
 *   "smilefufu" → "smilefufu"
 *   "56166799686@chatroom" → "56166799686@chatroom"
 */
export function extractPlatformTarget(platformSessionId: string): string {
  const parts = platformSessionId.split(':')
  if (parts.length >= 3 && parts[0] === 'agent') {
    return parts[parts.length - 1]
  }
  return platformSessionId
}
