import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { captureWorkspaceRelocationRecovery } from '../../src/core/workspace-relocation-recovery-capture.js'
import { archiveWorkspaceRelocationCheckpoint } from '../../src/core/workspace-relocation-checkpoints.js'
import { assertWorkspaceRecoveryProgress, verifyWorkspaceRecoveryProgress } from '../../src/core/workspace-relocation-recovery-commit.js'
const management = require('../../../scripts/lib/desktop-management.cjs')
const id = '12345678-1234-4123-8123-123456789abc', key = 'channel::original'

describe('original recovery scope stays fixed through its own checkpoint archival', () => {
  let root: string, data: string, manager: string, source: string, body: string, original: any
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-recovery-progress-')))
    data = management.ensurePrivateDataRoot(path.join(root, 'data')); manager = path.join(data, 'agent/managers/channel%3A%3Aoriginal')
    fs.mkdirSync(manager, { recursive: true }); source = path.join(manager, 'running.json')
    body = JSON.stringify({ episodeId: 'original', state: { key, recent: [], foldedCount: 0 }, envelopes: [], wakeIndex: -1, pending: [],
      hasEngineMessages: false, turns: [], responses: [], tools: [], pendingToolCallIds: [], adminChatClaims: [], transientMessageIds: [], spawnedWorkerIds: [],
      execution: { successfulSendMessageTargets: [], continuedWorkers: [], needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0 } })
    fs.writeFileSync(source, body, { mode: 0o600 })
    original = await captureWorkspaceRelocationRecovery(data)
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  async function archive() { const checkpoint = original.checkpoints[0]; return archiveWorkspaceRelocationCheckpoint({ dataDir: data, id, managerKey: key,
    source: checkpoint.source, beforeVersion: checkpoint.before_version, beforeSha256: checkpoint.before_sha256, verify: async () => {} }) }
  it('accepts its unchanged scope and the exact same scope after its own successful archival', async () => {
    expect(() => assertWorkspaceRecoveryProgress(original, original)).not.toThrow()
    expect(() => verifyWorkspaceRecoveryProgress(original)).not.toThrow()
    await archive()
    const current = await captureWorkspaceRelocationRecovery(data)
    expect(current.checkpoints).toEqual([])
    expect(() => assertWorkspaceRecoveryProgress(original, current)).not.toThrow()
    expect(() => verifyWorkspaceRecoveryProgress(original)).not.toThrow()
    expect(fs.readFileSync(path.join(manager, 'workspace-relocation-history', id, 'checkpoint.json'), 'utf8')).toBe(body)
  })
  it('does not interpret missing source alone as a completed archival', async () => {
    fs.unlinkSync(source)
    const current = await captureWorkspaceRelocationRecovery(data)
    expect(() => assertWorkspaceRecoveryProgress(original, current)).not.toThrow()
    expect(() => verifyWorkspaceRecoveryProgress(original)).not.toThrow()
    await expect(archive()).rejects.toThrow()
    expect(fs.existsSync(path.join(manager, 'workspace-relocation-history'))).toBe(false)
  })
  it('rejects a re-created checkpoint even when its text is identical', async () => {
    await archive(); fs.writeFileSync(source, body, { mode: 0o600 })
    const current = await captureWorkspaceRelocationRecovery(data)
    expect(() => assertWorkspaceRecoveryProgress(original, current)).toThrow()
    expect(() => verifyWorkspaceRecoveryProgress(original)).toThrow()
  })
  it('rejects a new unrelated file and never removes it as migration work', async () => {
    fs.writeFileSync(path.join(manager, 'unrelated'), 'preserve')
    const current = await captureWorkspaceRelocationRecovery(data)
    expect(() => assertWorkspaceRecoveryProgress(original, current)).toThrow()
    expect(() => verifyWorkspaceRecoveryProgress(original)).toThrow()
    expect(fs.readFileSync(path.join(manager, 'unrelated'), 'utf8')).toBe('preserve')
  })
  it('rejects replacement of a fixed Manager directory despite preserved source files', async () => {
    const kept = manager + '-kept'; fs.renameSync(manager, kept); fs.mkdirSync(manager); fs.renameSync(path.join(kept, 'running.json'), source)
    const current = await captureWorkspaceRelocationRecovery(data)
    expect(() => assertWorkspaceRecoveryProgress(original, current)).toThrow()
    expect(() => verifyWorkspaceRecoveryProgress(original)).toThrow()
    expect(fs.readFileSync(source, 'utf8')).toBe(body)
  })
})
