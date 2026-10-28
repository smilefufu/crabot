import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkspaceRecoveryRootVerifier } from '../../src/core/workspace-relocation-validation.js'

describe('current recovery Root verification', () => {
  it('authenticates and validates closed parameters before reading runtime or recovery materials', async () => {
    const runtimeIdentity = vi.fn(() => { throw new Error('Runtime facts must not be read') })
    const verify = createWorkspaceRecoveryRootVerifier({ dataDir: path.join(tmpdir(), 'absent-recovery-' + randomUUID()), moduleManagerPort: 1,
      runtimeBearer: () => 'current-runtime', runtimeIdentity, isClosing: () => false })
    const request = { intent_id: randomUUID(), recovery_id: randomUUID(), completion_sha256: 'a'.repeat(64), finalizing_sha256: 'b'.repeat(64) }
    await expect(verify(request)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(verify({ ...request, unexpected: true }, 'old-runtime')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    for (const invalid of [{ ...request, unexpected: true }, { ...request, recovery_id: 'old-id' }, { ...request, finalizing_sha256: null }, [], null]) {
      await expect(verify(invalid as any, 'current-runtime')).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    }
    expect(runtimeIdentity).not.toHaveBeenCalled()
  })
})
