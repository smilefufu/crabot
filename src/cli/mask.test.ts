import { describe, it, expect } from 'vitest'
import { maskSensitive, maskValue } from './mask.js'

describe('maskValue', () => {
  it('短字符串全 mask', () => {
    expect(maskValue('abc')).toBe('***')
    expect(maskValue('12345678')).toBe('***')
  })
  it('长字符串保留首尾 4 字符', () => {
    expect(maskValue('sk-proj-abcdefghij')).toBe('sk-p**********ghij')
  })
})

describe('maskSensitive', () => {
  it('mask 顶层 apikey 字段', () => {
    const input = { name: 'openai', apikey: 'sk-proj-abcdefghij', endpoint: 'https://x' }
    expect(maskSensitive(input)).toEqual({
      name: 'openai',
      apikey: 'sk-p**********ghij',
      endpoint: 'https://x',
    })
  })
  it('mask 嵌套字段', () => {
    const input = { config: { api_key: 'sk-abcdefghij123' } }
    expect(maskSensitive(input)).toEqual({ config: { api_key: 'sk-a********j123' } })
  })
  it('mask 数组中的对象', () => {
    const input = [{ apikey: 'aaaabbbbcccc' }, { apikey: 'xxxxyyyyzzzz' }]
    expect(maskSensitive(input)).toEqual([
      { apikey: 'aaaa****cccc' },
      { apikey: 'xxxx****zzzz' },
    ])
  })
  it('保留非敏感字段原样', () => {
    expect(maskSensitive({ name: 'foo', count: 42 })).toEqual({ name: 'foo', count: 42 })
  })
  it('识别多种敏感字段名', () => {
    const input = {
      apikey: 'aaaaaaaaaa', api_key: 'bbbbbbbbbb', password: 'cccccccccc',
      secret: 'dddddddddd', access_token: 'eeeeeeeeee', refresh_token: 'ffffffffff',
      client_secret: 'gggggggggg', webhook_secret: 'hhhhhhhhhh',
    }
    const out = maskSensitive(input) as Record<string, string>
    for (const v of Object.values(out)) {
      expect(v).toMatch(/^.{4}\*+.{4}$/)
    }
  })
})
