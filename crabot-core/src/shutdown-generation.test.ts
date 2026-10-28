import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ModuleManager from './index.js'

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })
describe('shutdown generation', () => {
  it('refuses mismatched/malformed generation and keeps legacy empty requests compatible', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'crabot-shutdown-generation-'))
    vi.stubEnv('CRABOT_INSTANCE_GENERATION', 'this-generation')
    vi.useFakeTimers()
    try {
      const mm = new ModuleManager({}, data) as any
      const stop = vi.spyOn(mm, 'stop').mockResolvedValue(undefined)
      const shutdown = mm.methodHandlers.get('shutdown')
      for (const expected_generation of ['other-generation', '', 123, null]) {
        await expect(shutdown({ expected_generation })).rejects.toMatchObject({ code: 'STALE_INSTANCE' })
      }
      await vi.runAllTimersAsync(); expect(stop).not.toHaveBeenCalled()
      await shutdown({ expected_generation: 'this-generation' })
      await vi.runAllTimersAsync(); expect(stop).toHaveBeenCalledTimes(1)
      await shutdown({}); await vi.runAllTimersAsync(); expect(stop).toHaveBeenCalledTimes(2)
    } finally { rmSync(data, { recursive: true, force: true }) }
  })
})
