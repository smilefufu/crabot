import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson } from 'crabot-shared'
import ModuleManager from './index.js'

const cacheKeys = ['workspaceStopSequence', 'workspaceFilePreparation', 'workspaceWorkerClosure', 'workspaceRootSelection', 'workspaceValidationLaunch',
  'workspaceValidationHealth', 'workspaceFinalizationPreparation', 'workspaceFinalizationResume', 'workspaceFinalizationCompletion'] as const
function fixture() {
  const manager = Object.create(ModuleManager.prototype) as any
  const request = { intent_id: randomUUID(), intent_sha256: 'a'.repeat(64) }, fingerprint = sha256CanonicalJson(request), scopes: unknown[] = []
  const identity = { pid: 100, parent: 99, started: 'first-birth', owner: 'fixture-owner', executable: '/fixture/node' }
  for (const key of cacheKeys) manager[key] = { fingerprint, pending: Promise.resolve('retained outcome') }
  manager.workspaceModuleStop = { fingerprint: sha256CanonicalJson(scopes) }
  manager.workspaceValidationProof = { request }
  manager.workspaceCoordinatorGrant = { proof: request, identity, revoke: vi.fn(), revoked: false }
  manager.workspaceFinalizationGrant = { request, launch: { process: identity }, revoked: false }
  manager.workspaceInitialJob = { proof: request, phase: 'needs_attention', stage: 'finalizing', reply: Promise.resolve({ intent_id: request.intent_id, accepted: true }) }
  return { manager, request, scopes, identity }
}
describe('recovered normal job memory retirement', () => {
  it('retains original outcomes until explicit post-exit retirement and clears only its own memory', async () => {
    const f = fixture(), initial = f.manager.workspaceInitialJob, reply = initial.reply, pending = f.manager.workspaceStopSequence.pending
    const retire = f.manager.prepareRecoveredWorkspaceJobRetirement(f.request, f.scopes, f.identity)
    expect(initial.phase).toBe('needs_attention'); expect(f.manager.workspaceStopSequence.pending).toBe(pending)
    retire()
    for (const key of cacheKeys) expect(f.manager[key]).toBeUndefined()
    for (const key of ['workspaceModuleStop', 'workspaceValidationProof', 'workspaceCoordinatorGrant', 'workspaceFinalizationGrant']) expect(f.manager[key]).toBeUndefined()
    expect(initial.phase).toBe('completed'); expect(initial.stage).toBe('finished')
    expect(initial.reply).toBe(reply); expect(await reply).toEqual({ intent_id: f.request.intent_id, accepted: true })
    expect(await pending).toBe('retained outcome')
  })
  it.each(['foreign cache', 'foreign scope', 'foreign role', 'unsettled driver'])('refuses before changing any memory for %s', mode => {
    const f = fixture()
    if (mode === 'foreign cache') f.manager.workspaceFilePreparation.fingerprint = 'different-job'
    if (mode === 'foreign scope') f.manager.workspaceModuleStop.fingerprint = 'different-scope'
    if (mode === 'foreign role') f.manager.workspaceCoordinatorGrant.identity = { ...f.identity, started: 'different-birth' }
    if (mode === 'unsettled driver') f.manager.workspaceInitialJob.phase = 'accepted'
    const initial = f.manager.workspaceInitialJob, stop = f.manager.workspaceStopSequence, grant = f.manager.workspaceFinalizationGrant
    expect(() => f.manager.prepareRecoveredWorkspaceJobRetirement(f.request, f.scopes, f.identity)).toThrow()
    expect(f.manager.workspaceInitialJob).toBe(initial); expect(initial.phase).toBe(mode === 'unsettled driver' ? 'accepted' : 'needs_attention')
    expect(f.manager.workspaceStopSequence).toBe(stop); expect(f.manager.workspaceFinalizationGrant).toBe(grant); expect(grant.revoked).toBe(false)
  })
  it('never clears a successor cache, role or initial job installed after capture', () => {
    const f = fixture(), retire = f.manager.prepareRecoveredWorkspaceJobRetirement(f.request, f.scopes, f.identity)
    const nextCache = { fingerprint: 'next-job' }, nextRole = { revoked: false }, nextJob = { phase: 'preparing' }
    f.manager.workspaceStopSequence = nextCache; f.manager.workspaceFinalizationGrant = nextRole; f.manager.workspaceInitialJob = nextJob
    retire()
    expect(f.manager.workspaceStopSequence).toBe(nextCache); expect(f.manager.workspaceFinalizationGrant).toBe(nextRole)
    expect(nextRole.revoked).toBe(false); expect(f.manager.workspaceInitialJob).toBe(nextJob); expect(nextJob.phase).toBe('preparing')
  })
  it('a fresh MM has no old normal role to retire and retains unrelated completed history', () => {
    const f = fixture(), manager = Object.create(ModuleManager.prototype) as any, history = { phase: 'completed', proof: { intent_id: randomUUID() } }
    manager.workspaceInitialJob = history
    manager.prepareRecoveredWorkspaceJobRetirement(f.request, f.scopes, f.identity)()
    expect(manager.workspaceInitialJob).toBe(history)
  })
})
