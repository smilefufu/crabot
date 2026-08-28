/**
 * manager model slot 解析(protocol-agent-v3.md §11)。
 *
 * 2026-08 槽位收敛(protocol-admin §3.19.11)：`'manager'` slot 已移除，
 * Manager loop 直接使用 `model_config.powerful`。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §11
 */

import type { LLMConnectionInfo } from '../types.js'

/**
 * 解析 manager loop 应使用的 LLM 连接信息。
 * 2026-08 槽位收敛后即 `model_config.powerful`；缺失则抛出明确错误
 * (manager loop 没有"跳过不跑"这条路,必须有一个可用的连接信息)。
 */
export function resolveManagerModelConfig(
  modelConfig: Record<string, LLMConnectionInfo> | undefined
): LLMConnectionInfo {
  const resolved = modelConfig?.powerful
  if (!resolved) {
    throw new Error(
      "[ManagerLoop] model_config 缺少 'powerful' slot，manager loop 无法解析可用的 LLM 连接信息"
    )
  }
  return resolved
}
