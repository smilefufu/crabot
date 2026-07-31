import { describe, it, expect } from 'vitest'
import { resolveManagerModelConfig } from '../../src/manager/model-slot.js'
import type { LLMConnectionInfo } from '../../src/types.js'

function makeConnInfo(model_id: string): LLMConnectionInfo {
  return { endpoint: 'https://example.test', apikey: 'k', model_id, format: 'anthropic' }
}

describe('resolveManagerModelConfig（protocol-agent-v3.md §11）', () => {
  it('有 manager slot：直接用它，不看 powerful', () => {
    const managerConn = makeConnInfo('manager-model')
    const powerfulConn = makeConnInfo('powerful-model')
    const resolved = resolveManagerModelConfig({ manager: managerConn, powerful: powerfulConn })
    expect(resolved).toBe(managerConn)
  })

  it('只有 powerful：回退用它', () => {
    const powerfulConn = makeConnInfo('powerful-model')
    const resolved = resolveManagerModelConfig({ powerful: powerfulConn })
    expect(resolved).toBe(powerfulConn)
  })

  it('manager 和 powerful 都没有：报明确错误', () => {
    expect(() => resolveManagerModelConfig({})).toThrow(/manager/)
    expect(() => resolveManagerModelConfig({ vision: makeConnInfo('v') })).toThrow(/powerful/)
  })

  it('model_config 整体为 undefined：同样报明确错误，不抛无关的 TypeError', () => {
    expect(() => resolveManagerModelConfig(undefined)).toThrow(/manager/)
  })
})
