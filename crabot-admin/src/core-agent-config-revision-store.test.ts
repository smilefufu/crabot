import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CoreAgentConfigRevisionStore } from './core-agent-config-revision-store.js'

describe('CoreAgentConfigRevisionStore', () => {
  it('commits monotonically through an outbox', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-revision-'))
    try {
      const store = new CoreAgentConfigRevisionStore(dir)
      expect((await store.load()).revision).toBe(1)
      expect((await store.commit(['models'], 'before', 'after')).revision).toBe(2)
      expect((await store.current()).semantic_fingerprint_hmac).toBe('after')
      await expect(fs.access(path.join(dir, 'config', 'core-agent-config-mutation-outbox.json'))).rejects.toThrow()
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
