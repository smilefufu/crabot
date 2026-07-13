/**
 * text-splitter 单元测试
 */

import { describe, it, expect } from 'vitest'
import { splitText } from '../src/text-splitter'

describe('splitText', () => {
  it('returns [] for empty', () => {
    expect(splitText('', 10)).toEqual([])
  })

  it('returns single chunk when within limit', () => {
    expect(splitText('hello', 10)).toEqual(['hello'])
  })

  it('splits on paragraph boundary', () => {
    const text = 'first para line\n\nsecond para line'
    const chunks = splitText(text, 20)
    expect(chunks).toEqual(['first para line', 'second para line'])
  })

  it('splits on newline when no paragraph boundary', () => {
    const text = 'line one here\nline two here'
    const chunks = splitText(text, 16)
    expect(chunks).toEqual(['line one here', 'line two here'])
  })

  it('splits on sentence ending', () => {
    const text = '第一句话。第二句话也很长。'
    const chunks = splitText(text, 7)
    expect(chunks[0]).toBe('第一句话。')
    expect(chunks.join('')).toBe('第一句话。第二句话也很长。')
  })

  it('every chunk respects maxLen', () => {
    const text = 'x'.repeat(250)
    const chunks = splitText(text, 100)
    expect(chunks.length).toBe(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
    expect(chunks.join('')).toBe(text)
  })

  it('hard-splits a long word with no boundaries', () => {
    const text = 'abcdefghij'.repeat(3) // 30 chars, no spaces
    const chunks = splitText(text, 10)
    expect(chunks).toEqual(['abcdefghij', 'abcdefghij', 'abcdefghij'])
  })
})
