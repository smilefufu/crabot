import { describe, it, expect } from 'vitest'
import { byteLength, truncateUtf8, truncateUtf8Tail, capWithMarker } from '../../src/engine/byte-cap'

describe('byte-cap', () => {
  describe('byteLength', () => {
    it('counts ASCII as 1 byte per char', () => {
      expect(byteLength('hello')).toBe(5)
    })

    it('counts Chinese as 3 bytes per char (UTF-8)', () => {
      expect(byteLength('你好')).toBe(6)
    })

    it('handles empty string', () => {
      expect(byteLength('')).toBe(0)
    })
  })

  describe('truncateUtf8', () => {
    it('returns original when under cap', () => {
      expect(truncateUtf8('hello', 100)).toBe('hello')
    })

    it('truncates ASCII at exact byte boundary', () => {
      expect(truncateUtf8('abcdef', 3)).toBe('abc')
    })

    it('does not split multi-byte char in the middle (Chinese)', () => {
      // '你好' = 6 bytes, cap to 4 bytes → must roll back to '你' (3 bytes)
      const out = truncateUtf8('你好', 4)
      expect(out).toBe('你')
      expect(byteLength(out)).toBeLessThanOrEqual(4)
    })

    it('handles 4-byte emoji correctly', () => {
      const s = 'a😀b' // 'a'=1, '😀'=4, 'b'=1 → 6 bytes
      // cap to 3 → keep 'a' only (next char would push to 5 bytes)
      const out = truncateUtf8(s, 3)
      expect(out).toBe('a')
    })
  })

  describe('truncateUtf8Tail', () => {
    it('returns original when under cap', () => {
      expect(truncateUtf8Tail('hello', 100)).toBe('hello')
    })

    it('keeps the tail, drops the head (ASCII)', () => {
      expect(truncateUtf8Tail('abcdef', 3)).toBe('def')
    })

    it('does not split multi-byte char at the cut point (Chinese)', () => {
      // '你好' = 6 bytes；cap 4 → 从尾部取 ≤4 字节 → 只能保留 '好'（3 字节）
      const out = truncateUtf8Tail('你好', 4)
      expect(out).toBe('好')
      expect(byteLength(out)).toBeLessThanOrEqual(4)
      expect(out).not.toContain('�')
    })

    it('handles 4-byte emoji at the cut point without lone surrogates', () => {
      const s = 'ab😀cd' // 1+1+4+1+1 = 8 bytes
      const out = truncateUtf8Tail(s, 6)
      // 尾部 6 字节处恰落在 😀 中间 → 整个 😀 被跳过，保留 'cd'... 实际：skip=2，
      // 逐 code point 跳过 'a'(1) 'b'(1) 后 bytes=2 ≥ skip → 从 '😀cd' 开始保留（6 字节）
      expect(out).toBe('😀cd')
      expect(byteLength(out)).toBeLessThanOrEqual(6)
      // cap 5 → skip=3，需再跳过 '😀'(4) → 保留 'cd'
      expect(truncateUtf8Tail(s, 5)).toBe('cd')
    })

    it('large CJK payload: kept tail is always ≤ cap', () => {
      const s = '中'.repeat(20000) // 60000 bytes
      const out = truncateUtf8Tail(s, 50000)
      expect(byteLength(out)).toBeLessThanOrEqual(50000)
      expect(out.endsWith('中')).toBe(true)
      expect(out).not.toContain('�')
    })
  })

  describe('capWithMarker', () => {
    it('returns original unchanged when under cap', () => {
      const r = capWithMarker('hello', 100, () => '[truncated]')
      expect(r.content).toBe('hello')
      expect(r.truncated).toBe(false)
    })

    it('appends marker and reports originalBytes when over cap', () => {
      const big = 'x'.repeat(1000)
      const r = capWithMarker(big, 100, (n) => `\n[truncated from ${n}]`)
      expect(r.truncated).toBe(true)
      expect(r.originalBytes).toBe(1000)
      expect(r.content.endsWith('[truncated from 1000]')).toBe(true)
      expect(byteLength(r.content)).toBeLessThanOrEqual(100)
    })

    it('preserves UTF-8 boundary when truncating', () => {
      const s = '中'.repeat(1000) // 3000 bytes
      const r = capWithMarker(s, 100, (n) => `[t:${n}]`)
      expect(r.truncated).toBe(true)
      // Result must be valid UTF-8 (no replacement chars from broken multi-byte)
      expect(r.content).not.toContain('�')
      expect(byteLength(r.content)).toBeLessThanOrEqual(100)
    })
  })
})
