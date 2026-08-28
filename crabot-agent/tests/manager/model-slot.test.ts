import { describe, it, expect } from 'vitest'
import { resolveManagerModelConfig } from '../../src/manager/model-slot.js'
import type { LLMConnectionInfo } from '../../src/types.js'

function makeConnInfo(model_id: string): LLMConnectionInfo {
  return { endpoint: 'https://example.test', apikey: 'k', model_id, format: 'anthropic' }
}

describe('resolveManagerModelConfig（protocol-agent-v3.md §11；2026-08 槽位收敛）', () => {
  it('manager 直接使用 powerful slot（manager 槽位已移除）', () => {
    const powerfulConn = makeConnInfo('powerful-model')
    const resolved = resolveManagerModelConfig({ powerful: powerfulConn })
    expect(resolved).toBe(powerfulConn)
  })

  it('powerful 和 vision 都没有：报明确错误', () => {
    expect(() => resolveManagerModelConfig({})).toThrow(/powerful/)
    expect(() => resolveManagerModelConfig({ vision: makeConnInfo('v') })).toThrow(/powerful/)
  })

  it('model_config 整体为 undefined：同样报明确错误，不抛无关的 TypeError', () => {
    expect(() => resolveManagerModelConfig(undefined)).toThrow(/powerful/)
  })
})
