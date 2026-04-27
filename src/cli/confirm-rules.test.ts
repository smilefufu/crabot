import { describe, it, expect } from 'vitest'
import { mustConfirm, generateToken, verifyToken, canonicalize, MUST_CONFIRM_COMMANDS } from './confirm-rules.js'

describe('mustConfirm', () => {
  it('删除类返回 true', () => {
    expect(mustConfirm('provider delete')).toBe(true)
    expect(mustConfirm('mcp delete')).toBe(true)
    expect(mustConfirm('skill delete')).toBe(true)
    expect(mustConfirm('schedule delete')).toBe(true)
    expect(mustConfirm('friend delete')).toBe(true)
    expect(mustConfirm('permission delete')).toBe(true)
  })
  it('schedule trigger 返回 true', () => {
    expect(mustConfirm('schedule trigger')).toBe(true)
  })
  it('其他写命令返回 false', () => {
    expect(mustConfirm('provider add')).toBe(false)
    expect(mustConfirm('agent restart')).toBe(false)
    expect(mustConfirm('mcp toggle')).toBe(false)
    expect(mustConfirm('config set')).toBe(false)
  })
  it('清单刚好 7 条', () => {
    expect(MUST_CONFIRM_COMMANDS.size).toBe(7)
  })
})

describe('canonicalize', () => {
  it('args 顺序无关', () => {
    const a = canonicalize('provider delete', { '--name': 'x', '_positional': 'gpt' })
    const b = canonicalize('provider delete', { '_positional': 'gpt', '--name': 'x' })
    expect(a).toBe(b)
  })
  it('--confirm 不参与', () => {
    const a = canonicalize('provider delete', { '_positional': 'x' })
    const b = canonicalize('provider delete', { '_positional': 'x', '--confirm': 'tok' })
    expect(a).toBe(b)
  })
})

describe('generateToken / verifyToken', () => {
  it('同一命令生成的 token 验证通过', () => {
    const args = { '_positional': 'gpt-azure' }
    const token = generateToken('provider delete', args)
    expect(verifyToken(token, 'provider delete', args)).toEqual({ valid: true })
  })
  it('不同命令的 token 验证失败', () => {
    const token = generateToken('provider delete', { '_positional': 'a' })
    const r = verifyToken(token, 'provider delete', { '_positional': 'b' })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toBe('mismatch')
  })
  it('过期 token 验证失败', () => {
    const args = { '_positional': 'x' }
    const past = Math.floor(Date.now() / 1000) - 16 * 60
    const sameHashToken = generateToken('provider delete', args).split('-')[0] + '-' + past
    const r = verifyToken(sameHashToken, 'provider delete', args)
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toBe('expired')
  })
  it('恶意构造的 malformed token 报错', () => {
    const r = verifyToken('not-a-valid-token-format-extra', 'provider delete', {})
    expect(r.valid).toBe(false)
  })
})
