import { describe, it, expect } from 'vitest'
import { buildCreateProviderBody } from './provider.js'

describe('buildCreateProviderBody', () => {
  it('最小合法输入（manual + openai）', () => {
    const body = buildCreateProviderBody({
      name: 'OpenAI',
      format: 'openai',
      endpoint: 'https://api.openai.com',
      apikey: 'sk-test',
    })
    expect(body).toEqual({
      name: 'OpenAI',
      type: 'manual',
      format: 'openai',
      endpoint: 'https://api.openai.com',
      api_key: 'sk-test',
      models: [],
    })
  })

  it('字段名是 api_key（下划线）不是 apikey', () => {
    const body = buildCreateProviderBody({
      name: 'X',
      format: 'openai',
      endpoint: 'https://x',
      apikey: 'k',
    })
    expect(body).toHaveProperty('api_key')
    expect(body).not.toHaveProperty('apikey')
  })

  it('models 字段必存在（admin 协议必填）', () => {
    const body = buildCreateProviderBody({
      name: 'X',
      format: 'openai',
      endpoint: 'https://x',
    })
    expect(body['models']).toEqual([])
  })

  it('format 字段必存在（admin 协议必填）', () => {
    const body = buildCreateProviderBody({
      name: 'X',
      format: 'anthropic',
      endpoint: 'https://x',
    })
    expect(body['format']).toBe('anthropic')
  })

  it('--type 默认为 manual', () => {
    const body = buildCreateProviderBody({
      name: 'X',
      format: 'openai',
      endpoint: 'https://x',
    })
    expect(body['type']).toBe('manual')
  })

  it('preset 类型 + preset_vendor', () => {
    const body = buildCreateProviderBody({
      name: 'OpenAI',
      type: 'preset',
      format: 'openai',
      endpoint: 'https://api.openai.com',
      presetVendor: 'openai',
      apikey: 'sk-x',
    })
    expect(body).toMatchObject({
      type: 'preset',
      preset_vendor: 'openai',
    })
  })

  it('支持的 4 种 format', () => {
    for (const format of ['openai', 'anthropic', 'gemini', 'openai-responses']) {
      expect(() =>
        buildCreateProviderBody({ name: 'X', format, endpoint: 'https://x' })
      ).not.toThrow()
    }
  })

  it('非法 format 报错', () => {
    expect(() =>
      buildCreateProviderBody({ name: 'X', format: 'huggingface', endpoint: 'https://x' })
    ).toThrow(/format 必须是/)
  })

  it('非法 type 报错', () => {
    expect(() =>
      buildCreateProviderBody({
        name: 'X',
        type: 'auto',
        format: 'openai',
        endpoint: 'https://x',
      })
    ).toThrow(/type 必须是/)
  })

  it('--name 为空报错', () => {
    expect(() =>
      buildCreateProviderBody({ name: '   ', format: 'openai', endpoint: 'https://x' })
    ).toThrow(/name 不能为空/)
  })

  it('--endpoint 为空报错', () => {
    expect(() => buildCreateProviderBody({ name: 'X', format: 'openai', endpoint: '' })).toThrow(
      /endpoint 不能为空/
    )
  })
})
