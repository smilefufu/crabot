import { describe, it, expect } from 'vitest'
import { createLSPManager } from '../../src/lsp/lsp-manager'

describe('LSPManager', () => {
  it('creates without error', () => {
    const manager = createLSPManager()
    expect(manager).toBeDefined()
  })

  it('isLanguageAvailable returns false before start', () => {
    const manager = createLSPManager()
    expect(manager.isLanguageAvailable('typescript')).toBe(false)
  })

  it('getDiagnostics returns empty for unstarted language', async () => {
    const manager = createLSPManager()
    const diags = await manager.getDiagnostics('/src/foo.ts')
    expect(diags).toEqual([])
  })

  it('notifyFileChanged does not throw for unstarted language', () => {
    const manager = createLSPManager()
    expect(() => manager.notifyFileChanged('/src/foo.ts', 'const x = 1')).not.toThrow()
  })

  it('stop does not throw when nothing started', async () => {
    const manager = createLSPManager()
    await expect(manager.stop()).resolves.toBeUndefined()
  })
})
