import test from 'node:test'
import assert from 'node:assert/strict'
import { finishUbuntuInstallation, ensureUbuntuProgramsReady, probeFailurePhase, ubuntuInstallationFailure } from '../dist/ubuntu-installation.js'
function fixture() {
  const calls = [], abort = new AbortController()
  const options = { signal: abort.signal, probe: async () => { calls.push('probe') }, authorizationNeeded: async () => { calls.push('needed'); return true },
    authorize: async () => { calls.push('authorize') }, register: async () => { calls.push('register') }, commit: async () => { calls.push('commit'); return 'installed' } }
  return { calls, abort, options }
}
test('a working real probe completes without requesting system authorization', async () => {
  const f = fixture(); assert.equal(await finishUbuntuInstallation(f.options), 'installed')
  assert.deepEqual(f.calls, ['probe', 'register', 'commit'])
})
test('OS authorization never substitutes for a second successful sandbox and network probe', async () => {
  const f = fixture(); let count = 0
  f.options.probe = async () => { f.calls.push('probe'); if (++count === 1) throw new Error('restricted') }
  await finishUbuntuInstallation(f.options)
  assert.deepEqual(f.calls, ['probe', 'needed', 'authorize', 'probe', 'register', 'commit'])
})
for (const failure of ['declined', 'probe still fails', 'not AppArmor', 'cancelled after auth']) test(failure + ' retains preparation without publishing an entry or selection', async () => {
  const f = fixture(); f.options.probe = async () => { f.calls.push('probe'); throw new Error('not ready') }
  if (failure === 'declined') f.options.authorize = async () => { throw new Error('declined') }
  if (failure === 'not AppArmor') f.options.authorizationNeeded = async () => false
  if (failure === 'cancelled after auth') f.options.authorize = async () => f.abort.abort()
  await assert.rejects(finishUbuntuInstallation(f.options))
  assert.equal(f.calls.includes('register'), false); assert.equal(f.calls.includes('commit'), false)
})
test('entry conflict cannot commit a prepared selection', async () => {
  const f = fixture(); f.options.register = async () => { throw new Error('conflict') }
  await assert.rejects(finishUbuntuInstallation(f.options)); assert.equal(f.calls.includes('commit'), false)
})
test('pre-cancelled installation executes no probes or system operations', async () => {
  const f = fixture(); f.abort.abort(); await assert.rejects(finishUbuntuInstallation(f.options)); assert.deepEqual(f.calls, [])
})

test('once OS entry publication begins, completion retains its final commit boundary', async () => {
  const f = fixture(); f.options.register = async () => { f.calls.push('register'); f.abort.abort() }
  assert.equal(await finishUbuntuInstallation(f.options), 'installed')
  assert.deepEqual(f.calls, ['probe', 'register', 'commit'])
})

test('failure feedback contains only closed codes and phases, never raw third-party errors', () => {
  const error = { code: 'CRABOT_INSTALL_GUI_SANDBOX', phase: 'kernel', message: 'Bearer private-secret', stack: 'untrusted/path' }
  assert.deepEqual(ubuntuInstallationFailure(error, false), { code: 'CRABOT_INSTALL_GUI_SANDBOX', phase: 'kernel' })
  assert.deepEqual(ubuntuInstallationFailure({ ...error, code: 'foreign-secret', phase: 'private-secret' }, false), { code: 'NOT_READY' })
  assert.deepEqual(ubuntuInstallationFailure(error, true), { code: 'CANCELLED', phase: 'kernel' })
  assert.deepEqual(ubuntuInstallationFailure(null, false), { code: 'NOT_READY' })
})
test('probe stderr accepts only a complete fixed diagnostic line', () => {
  assert.equal(probeFailurePhase('third party log\nCRABOT_GUI_SANDBOX_PROBE_FAILED:kernel\n'), 'kernel')
  assert.equal(probeFailurePhase('CRABOT_BROWSER_SANDBOX_PROBE_FAILED:scrapling-fetch\r\n'), 'scrapling-fetch')
  for (const text of ['secret', 'CRABOT_GUI_SANDBOX_PROBE_FAILED:kernel', 'CRABOT_GUI_SANDBOX_PROBE_FAILED:kernel-secret\n']) assert.equal(probeFailurePhase(text), undefined)
})

test('shared readiness preserves update semantics without first-install entries or selection', async () => {
  const f = fixture(); let count = 0
  f.options.probe = async () => { f.calls.push('probe'); if (++count === 1) throw new Error('restricted') }
  await ensureUbuntuProgramsReady(f.options)
  assert.deepEqual(f.calls, ['probe', 'needed', 'authorize', 'probe'])
})
