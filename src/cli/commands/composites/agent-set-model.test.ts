import { describe, it, expect } from 'vitest'
import { buildAgentSetModelBody } from './agent-set-model.js'

describe('buildAgentSetModelBody', () => {
  it('正确组装 model_config 嵌套结构', () => {
    expect(
      buildAgentSetModelBody({
        slot: 'fast',
        provider: 'openai-name',
        providerId: 'prov-uuid-123',
        model: 'gpt-4o',
        existingSlots: {},
      })
    ).toEqual({
      model_config: {
        fast: { provider_id: 'prov-uuid-123', model_id: 'gpt-4o' },
      },
    })
  })

  it('顶层字段名是 model_config 不是 models（admin 协议）', () => {
    const body = buildAgentSetModelBody({
      slot: 'default',
      provider: 'p',
      providerId: 'pid',
      model: 'm',
      existingSlots: {},
    })
    expect(body).toHaveProperty('model_config')
    expect(body).not.toHaveProperty('models')
  })

  it('保留其他 slot（admin updateConfig 整体替换 model_config 不 merge）', () => {
    const body = buildAgentSetModelBody({
      slot: 'triage',
      provider: 'p',
      providerId: 'new-pid',
      model: 'new-model',
      existingSlots: {
        triage: { provider_id: 'old-pid', model_id: 'old-model' },
        worker: { provider_id: 'wpid', model_id: 'wmodel' },
      },
    })
    // worker slot 必须保留，否则 admin updateConfig 会把它丢掉
    expect(body).toEqual({
      model_config: {
        triage: { provider_id: 'new-pid', model_id: 'new-model' },
        worker: { provider_id: 'wpid', model_id: 'wmodel' },
      },
    })
  })

  it('忽略 existingSlots 中 null 或不完整的项（avoid PATCH 写入脏数据）', () => {
    const body = buildAgentSetModelBody({
      slot: 'fast',
      provider: 'p',
      providerId: 'pid',
      model: 'm',
      existingSlots: {
        triage: null,
        broken: { provider_id: 'p', model_id: '' } as { provider_id: string; model_id: string },
        worker: { provider_id: 'wp', model_id: 'wm' },
      },
    })
    const mc = (body['model_config'] as Record<string, unknown>)
    expect(Object.keys(mc).sort()).toEqual(['fast', 'worker'])
  })

  it('--slot 为空报错', () => {
    expect(() =>
      buildAgentSetModelBody({
        slot: '',
        provider: 'p',
        providerId: 'pid',
        model: 'm',
        existingSlots: {},
      })
    ).toThrow(/slot 不能为空/)
  })

  it('--model 为空报错', () => {
    expect(() =>
      buildAgentSetModelBody({
        slot: 's',
        provider: 'p',
        providerId: 'pid',
        model: '',
        existingSlots: {},
      })
    ).toThrow(/model 不能为空/)
  })

  it('provider id 解析失败时报错', () => {
    expect(() =>
      buildAgentSetModelBody({
        slot: 's',
        provider: 'p',
        providerId: '',
        model: 'm',
        existingSlots: {},
      })
    ).toThrow(/provider id 解析失败/)
  })
})
