/**
 * 槽位 thinking 配置校验（spec 2026-08 §4.4 / §9.3）。
 */
import { describe, it, expect } from 'vitest'
import { validateAgentSlotThinking } from '../src/agent-config-thinking.js'

const ROLE_KEYS = new Set(['powerful', 'cost_effective'])

/** 默认所有 slot 生效 format=anthropic；个别用例覆写（显式 undefined 表示 provider 查不到） */
function formatsBy(overrides: Record<string, string | undefined> = {}) {
  return (roleKey: string) => (roleKey in overrides ? overrides[roleKey] : 'anthropic')
}

describe('validateAgentSlotThinking', () => {
  it('合法配置通过（level / custom 字符串 / custom 数字×anthropic）', () => {
    expect(() => validateAgentSlotThinking(undefined, undefined, ROLE_KEYS, formatsBy())).not.toThrow()
    expect(() => validateAgentSlotThinking(undefined, {
      powerful: { thinking_level: 'high' },
      cost_effective: { thinking_level: 'off' },
    }, ROLE_KEYS, formatsBy())).not.toThrow()
    expect(() => validateAgentSlotThinking(undefined, {
      powerful: { thinking_custom: 'xhigh' },
    }, ROLE_KEYS, formatsBy())).not.toThrow()
    expect(() => validateAgentSlotThinking({
      powerful: { provider_id: 'p', model_id: 'm' },
    }, {
      powerful: { thinking_custom: 8192 },
    }, ROLE_KEYS, formatsBy())).not.toThrow()
  })

  it('slot key 不在 CoreAgentModelRole 内拒绝（含 thinking 独立校验）', () => {
    expect(() => validateAgentSlotThinking({ vision: { provider_id: 'p', model_id: 'm' } }, undefined, ROLE_KEYS, formatsBy()))
      .toThrow(/Unknown core Agent model slot key: vision/)
    expect(() => validateAgentSlotThinking(undefined, { manager: { thinking_level: 'high' } }, ROLE_KEYS, formatsBy()))
      .toThrow(/Unknown core Agent thinking slot key: manager/)
  })

  it('thinking_level 枚举外拒绝', () => {
    expect(() => validateAgentSlotThinking(undefined, { powerful: { thinking_level: 'max' as never } }, ROLE_KEYS, formatsBy()))
      .toThrow(/invalid thinking_level/)
  })

  it('thinking_custom 非空白字符串/正整数拒绝', () => {
    expect(() => validateAgentSlotThinking(undefined, { powerful: { thinking_custom: '   ' } }, ROLE_KEYS, formatsBy()))
      .toThrow(/非空白字符串或正整数/)
    expect(() => validateAgentSlotThinking(undefined, { powerful: { thinking_custom: -1 } }, ROLE_KEYS, formatsBy()))
      .toThrow(/非空白字符串或正整数/)
    expect(() => validateAgentSlotThinking(undefined, { powerful: { thinking_custom: 1.5 } }, ROLE_KEYS, formatsBy()))
      .toThrow(/非空白字符串或正整数/)
  })

  it('thinking_level 与 thinking_custom 互斥', () => {
    expect(() => validateAgentSlotThinking(undefined, { powerful: { thinking_level: 'high', thinking_custom: 'xhigh' } }, ROLE_KEYS, formatsBy()))
      .toThrow(/互斥/)
  })

  it('数字 thinking_custom × 非 anthropic format 拒绝', () => {
    expect(() => validateAgentSlotThinking(undefined, { powerful: { thinking_custom: 8192 } }, ROLE_KEYS, formatsBy({ powerful: 'openai' })))
      .toThrow(/仅 anthropic/)
    expect(() => validateAgentSlotThinking(undefined, { cost_effective: { thinking_custom: 8192 } }, ROLE_KEYS, formatsBy({ cost_effective: 'gemini' })))
      .toThrow(/仅 anthropic/)
    // 生效 provider 查不到（undefined）时同样拒绝
    expect(() => validateAgentSlotThinking(undefined, { powerful: { thinking_custom: 8192 } }, ROLE_KEYS, formatsBy({ powerful: undefined })))
      .toThrow(/仅 anthropic/)
    // 字符串自定义不受 format 限制
    expect(() => validateAgentSlotThinking(undefined, { powerful: { thinking_custom: 'xhigh' } }, ROLE_KEYS, formatsBy({ powerful: 'openai' })))
      .not.toThrow()
  })
})
