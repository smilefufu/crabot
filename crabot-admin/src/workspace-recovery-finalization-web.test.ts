import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createWorkspaceRecoveryFinalizationWeb } from './workspace-recovery-finalization-web.js'

const management = require('../../scripts/lib/desktop-management.cjs')

describe('current recovery completion preparation authentication', () => {
  it('requires a credential before own runtime reads and does not inspect caller fields before canonical authentication', async () => {
    const metadata = vi.spyOn(management, 'requirePrivateDataRoot').mockImplementation(() => { throw new Error('No current runtime proof') })
    const identity = vi.fn(() => ({ instance_id: 'fixture-instance', module_id: 'admin-web', runtime_id: randomUUID() })), quiesce = vi.fn(async () => {})
    try {
      const web = createWorkspaceRecoveryFinalizationWeb({ dataDir: path.join(tmpdir(), 'absent-completion-' + randomUUID()), moduleManagerPort: 1,
        modulePort: 2, runtimeIdentity: identity, quiesce })
      await expect(web.prepare({ unexpected: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(metadata).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled()
      await expect(web.prepare({ unexpected: true }, 'unverified-credential')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(metadata).toHaveBeenCalledOnce(); expect(quiesce).not.toHaveBeenCalled()
      await expect(web.prepare(null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(metadata).toHaveBeenCalledOnce()
    } finally { metadata.mockRestore() }
  })
})
