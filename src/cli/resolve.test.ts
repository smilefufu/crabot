import { describe, it, expect, vi } from 'vitest'
import { resolveRef } from './resolve.js'
import { CliError } from './errors.js'

function makeClient(items: Array<{ id: string; name: string }>) {
  return { get: vi.fn(async () => items) } as any
}

describe('resolveRef', () => {
  const items = [
    { id: 'a3c1f9e2-1111', name: 'openai' },
    { id: 'b4d2e8f3-2222', name: 'gpt-azure' },
    { id: 'c5e3f7g4-3333', name: 'gpt-local' },
  ]

  it('完整 UUID 命中', async () => {
    const r = await resolveRef(makeClient(items), 'provider', 'a3c1f9e2-1111')
    expect(r.id).toBe('a3c1f9e2-1111')
  })

  it('name 唯一命中', async () => {
    const r = await resolveRef(makeClient(items), 'provider', 'openai')
    expect(r.id).toBe('a3c1f9e2-1111')
  })

  it('短前缀唯一命中', async () => {
    const r = await resolveRef(makeClient(items), 'provider', 'b4d2')
    expect(r.id).toBe('b4d2e8f3-2222')
  })

  it('短前缀少于 4 字符报 INVALID_ARGUMENT', async () => {
    await expect(resolveRef(makeClient(items), 'provider', 'b4'))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('多名称匹配报 AMBIGUOUS_REFERENCE', async () => {
    const dup = [{ id: 'x1aaaaaa', name: 'foo' }, { id: 'x2bbbbbb', name: 'foo' }]
    await expect(resolveRef(makeClient(dup), 'provider', 'foo'))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_REFERENCE' })
  })

  it('多前缀匹配报 AMBIGUOUS_REFERENCE，details.candidates 包含两条', async () => {
    const dup = [{ id: 'abcd1111', name: 'a' }, { id: 'abcd2222', name: 'b' }]
    try {
      await resolveRef(makeClient(dup), 'provider', 'abcd')
      throw new Error('should throw')
    } catch (e) {
      expect((e as CliError).code).toBe('AMBIGUOUS_REFERENCE')
      expect((e as CliError).details?.candidates).toHaveLength(2)
    }
  })

  it('找不到报 NOT_FOUND', async () => {
    await expect(resolveRef(makeClient(items), 'provider', 'zzzz9999'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
