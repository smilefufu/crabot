import { describe, expect, it } from 'vitest'
import { decodePathSegment, isPathSafeSegment } from './http-path.js'

describe('decodePathSegment', () => {
  it('解码中文 percent-encoding（事故复现：中文 module_id 重启）', () => {
    expect(decodePathSegment('/api/modules/%E5%BE%AE%E4%BF%A1/restart', 3)).toBe('微信')
  })

  it('ASCII 段原样返回', () => {
    expect(decodePathSegment('/api/modules/feishu-prod/restart', 3)).toBe('feishu-prod')
  })

  it('无效编码不抛异常，返回原始段', () => {
    expect(decodePathSegment('/api/modules/%E5%/restart', 3)).toBe('%E5%')
  })

  it('越界索引返回空串', () => {
    expect(decodePathSegment('/api/modules', 3)).toBe('')
  })
})

describe('isPathSafeSegment', () => {
  it('路径穿越段判定为不安全', () => {
    expect(isPathSafeSegment('../../x')).toBe(false)
  })

  it('中文模块名判定为安全', () => {
    expect(isPathSafeSegment('微信客服')).toBe(true)
  })

  it('普通 ASCII 模块名判定为安全', () => {
    expect(isPathSafeSegment('feishu-prod')).toBe(true)
  })

  it('含反斜杠判定为不安全', () => {
    expect(isPathSafeSegment('..\\..\\x')).toBe(false)
  })

  it('空串判定为不安全', () => {
    expect(isPathSafeSegment('')).toBe(false)
  })
})
