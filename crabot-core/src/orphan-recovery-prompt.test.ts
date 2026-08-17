import { describe, expect, it, vi } from 'vitest'
import { createOrphanTerminationConfirmer } from './orphan-recovery-prompt.js'
import type { OrphanTerminationCandidate } from './module-runtime-registry.js'

const candidate: OrphanTerminationCandidate = {
  record: {
    schema_version: 1,
    instance_id: 'instance-1',
    runtime_id: 'runtime-1',
    module_id: 'crabot-agent',
    root_pid: 100,
    process_start_identity: 'root-start',
    module_port: 19003,
    created_at: '2026-08-17T00:00:00.000Z',
  },
  record_path: 'C:\\crabot\\records\\runtime-1.json',
  listener: {
    pid: 200,
    process_name: 'node.exe',
    command_line: 'node dist/main.js',
    process_start_identity: 'listener-start',
  },
}

describe('createOrphanTerminationConfirmer', () => {
  it('is unavailable for non-interactive startup', () => {
    expect(createOrphanTerminationConfirmer({ interactive: false })).toBeUndefined()
  })

  it.each(['y', 'Y', 'yes', ' YES '])('accepts explicit approval %j', async answer => {
    const write = vi.fn()
    const confirm = createOrphanTerminationConfirmer({
      interactive: true,
      ask: async () => answer,
      write,
    })

    await expect(confirm!(candidate)).resolves.toBe(true)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('listener_pid: 200'))
  })

  it.each(['', 'n', 'no', 'anything else'])('declines answer %j', async answer => {
    const confirm = createOrphanTerminationConfirmer({
      interactive: true,
      ask: async () => answer,
      write: () => undefined,
    })

    await expect(confirm!(candidate)).resolves.toBe(false)
  })
})
