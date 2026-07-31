/**
 * manager model slot 解析(protocol-agent-v3.md §11)。
 *
 * `model_config` 新增的 `'manager'` slot 是 admin 侧 additive 可选项(见
 * `crabot-admin/src/agent-manager.ts` builtin `model_roles`,`fallback: 'none'`)——
 * 未显式配置时 Admin 不会自动拿全局默认去填充它,而是原样不下发该键。真正的回退语义在
 * agent 这一侧完成:`model_config.manager ?? model_config.powerful`,两者都缺才报错。
 * 这样当用户已经给 `powerful` 配了非默认的 provider/model 时,manager 会跟着用 `powerful`
 * 的实际值,而不是被 Admin 的全局默认覆盖掉。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §11
 */

import type { LLMConnectionInfo } from '../types.js'

/**
 * 解析 manager loop 应使用的 LLM 连接信息。
 * 回退链:`model_config.manager` → `model_config.powerful`;两者都未配置则抛出明确错误
 * (manager loop 没有"跳过不跑"这条路,必须有一个可用的连接信息)。
 */
export function resolveManagerModelConfig(
  modelConfig: Record<string, LLMConnectionInfo> | undefined
): LLMConnectionInfo {
  const resolved = modelConfig?.manager ?? modelConfig?.powerful
  if (!resolved) {
    throw new Error(
      "[ManagerLoop] model_config 缺少 'manager' 与 'powerful' 两个 slot，manager loop 无法解析可用的 LLM 连接信息"
    )
  }
  return resolved
}
