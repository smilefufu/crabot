import { describe, it, expect } from 'vitest'
import { detectLanguage } from '../../src/lsp/configs'

describe('detectLanguage', () => {
  it('detects TypeScript', () => {
    expect(detectLanguage('/src/foo.ts')).toBe('typescript')
    expect(detectLanguage('/src/foo.tsx')).toBe('typescript')
    expect(detectLanguage('/src/foo.js')).toBe('typescript')
  })

  it('detects Python', () => {
    expect(detectLanguage('/src/foo.py')).toBe('python')
  })

  it('detects Rust', () => {
    expect(detectLanguage('/src/foo.rs')).toBe('rust')
  })

  it('detects Go', () => {
    expect(detectLanguage('/src/foo.go')).toBe('go')
  })

  it('returns undefined for unknown extension', () => {
    expect(detectLanguage('/src/foo.rb')).toBeUndefined()
    expect(detectLanguage('/src/foo.md')).toBeUndefined()
  })
})
