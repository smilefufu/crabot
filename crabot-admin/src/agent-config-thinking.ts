/**
 * 槽位 thinking 配置校验（2026-08，protocol-admin §3.19.6；spec §4.4）。
 * 纯函数便于单测；AdminModule 侧负责组装 roleKeys 与 provider format 解析回调。
 */
import type { ModelSlotRef, SlotThinkingConfig } from './types.js'

const VALID_THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const

/**
 * 校验 update_agent_config 请求中的槽位 thinking 配置。
 *
 * @param roleKeys 当前 CoreAgentModelRole 集合（{powerful, cost_effective}）
 * @param resolveProviderFormat 给定 slot key，返回其**生效引用**（槽位覆盖的 provider，
 *   否则全局默认 provider）的 format；查不到返回 undefined。
 *   数字 thinking_custom 仅 anthropic 支持在此判定。
 * @throws Error 带明确原因（REST 层映射 400 / RPC 直接上抛）
 */
export function validateAgentSlotThinking(
  modelConfig: Record<string, ModelSlotRef> | undefined,
  thinking: Record<string, SlotThinkingConfig> | undefined,
  roleKeys: ReadonlySet<string>,
  resolveProviderFormat: (roleKey: string) => string | undefined,
): void {
  for (const key of Object.keys(modelConfig ?? {})) {
    if (!roleKeys.has(key)) throw new Error(`Unknown core Agent model slot key: ${key}`)
  }
  if (!thinking) return
  for (const [key, cfg] of Object.entries(thinking)) {
    if (!roleKeys.has(key)) throw new Error(`Unknown core Agent thinking slot key: ${key}`)
    const thinkingLevel = cfg?.thinking_level
    const thinkingCustom = cfg?.thinking_custom
    if (thinkingLevel !== undefined && !VALID_THINKING_LEVELS.includes(thinkingLevel)) {
      throw new Error(`Slot "${key}": invalid thinking_level: ${JSON.stringify(thinkingLevel)}`)
    }
    if (thinkingCustom !== undefined) {
      const isNonEmptyString = typeof thinkingCustom === 'string' && thinkingCustom.trim().length > 0
      const isPositiveInt = typeof thinkingCustom === 'number' && Number.isInteger(thinkingCustom) && thinkingCustom > 0
      if (!isNonEmptyString && !isPositiveInt) {
        throw new Error(`Slot "${key}": thinking_custom 必须为非空白字符串或正整数`)
      }
    }
    if (thinkingLevel !== undefined && thinkingCustom !== undefined) {
      throw new Error(`Slot "${key}": thinking_level 与 thinking_custom 互斥，只能配一个`)
    }
    if (typeof thinkingCustom === 'number') {
      // 数字 budget 参数只有 Anthropic 老模型存在；format 在编辑抽屉不可变，保存时判定一次
      const format = resolveProviderFormat(key)
      if (format !== 'anthropic') {
        throw new Error(`Slot "${key}": 数字 thinking_custom 仅 anthropic 格式的模型支持`)
      }
    }
  }
}
