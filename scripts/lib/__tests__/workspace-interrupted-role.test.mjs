import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import native from '../process-identity.cjs'
import management from '../desktop-management.cjs'
import { acquireCliLock, acquireWorkspaceRelocationLock, cliLockToken, releaseCliLock } from '../cli-lock.mjs'
import { beginWorkspaceRelocationIntent, readWorkspaceInterruptedRelocationCheckpoint, commitWorkspaceRelocationCoordinator } from '../workspace-relocation-intent.mjs'
import { launchWorkspaceInterruptedRecoveryCoordinator } from '../workspace-interrupted-launch.mjs'
import { readWorkspaceInterruptedRecoveryRole } from '../workspace-interrupted-role.mjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson as hash } from '../../../crabot-shared/dist/canonical-json.js'

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-interrupted-role-中文 '))), data = management.ensurePrivateDataRoot(path.join(root, 'data')), id = randomUUID()
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  const lock = await acquireCliLock(data, 'workspace-relocation')
  await beginWorkspaceRelocationIntent({ dataDir: data, id, target: path.join(root, 'new'), expectedRevision: (await catalog.snapshot()).revision, protectedRoots: [] })
  releaseCliLock(lock)
  const children = []
  t.after(async () => {
    for (const item of children) {
      item.close?.()
      if (item.child.connected) item.child.disconnect()
      if (item.child.exitCode === null && item.child.signalCode === null) await once(item.child, 'exit')
    }
    releaseCliLock(path.join(data, 'cli.lock')); fs.rmSync(root, { recursive: true, force: true })
  })
  const request = { intent_id: id, recovery_id: randomUUID(), checkpoint_sha256: readWorkspaceInterruptedRelocationCheckpoint(data, id).checkpoint_sha256 }
  const options = () => ({ dataDir: data, request, verify: async () => {}, releaseParentLock: () => releaseCliLock(path.join(data, 'cli.lock')) })
  return { root, data, id, request, options, children }
}

test('a new actual Node recovery role owns its mutex and leaves the old intent unchanged', { timeout: 45000 }, async t => {
  const f = await fixture(t), before = readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  const lock = await acquireWorkspaceRelocationLock(f.data, f.id)
  const role = await launchWorkspaceInterruptedRecoveryCoordinator(f.options()); f.children.push(role)
  assert.equal(cliLockToken(lock), undefined)
  assert.equal(role.launch.schema_version, 2)
  assert.equal(role.launch.action, 'restore_source')
  assert.equal(role.launch.parent.pid, process.pid)
  assert.notEqual(role.launch.process.pid, process.pid)
  assert.equal(role.launch.process.parent, process.pid)
  assert.deepEqual(readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id), before)
  assert.deepEqual(readWorkspaceInterruptedRecoveryRole(f.data, f.request.recovery_id), { launch: role.launch, ready: role.ready })
  await role.verify(); await role.verify()
  await assert.rejects(acquireWorkspaceRelocationLock(f.data, f.id, 0), /another crabot CLI operation/)
  assert.equal(fs.existsSync(path.join(f.root, 'new')), false)
  const exited = once(role.child, 'exit'); role.close(); await exited
  const available = await acquireWorkspaceRelocationLock(f.data, f.id, 0); releaseCliLock(available)
  await assert.rejects(role.verify(), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
})

for (const mode of ['no lock', 'changed checkpoint', 'unconfirmed human', 'arbitrary entry']) test('a new interrupted role rejects ' + mode + ' before publishing launch', { timeout: 45000 }, async t => {
  const f = await fixture(t)
  if (mode !== 'no lock') await acquireWorkspaceRelocationLock(f.data, f.id)
  const options = f.options()
  if (mode === 'changed checkpoint') options.request = { ...f.request, checkpoint_sha256: '0'.repeat(64) }
  if (mode === 'unconfirmed human') options.verify = async () => { throw new Error('Current human rejected') }
  if (mode === 'arbitrary entry') options.entry = 'not-an-allowed-script'
  await assert.rejects(launchWorkspaceInterruptedRecoveryCoordinator(options), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
  assert.equal(readWorkspaceInterruptedRecoveryRole(f.data, f.request.recovery_id).launch, null)
  assert.equal(fs.existsSync(path.join(f.root, 'new')), false)
})

test('an old live coordinator is not replaced or impersonated by a recovery generation', { timeout: 45000 }, async t => {
  const f = await fixture(t), lock = await acquireWorkspaceRelocationLock(f.data, f.id)
  const child = spawn(process.execPath, ['-e', "process.on('disconnect',()=>process.exit(0));process.send('ready')"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  f.children.push({ child }); await once(child, 'message')
  const original = commitWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.id, launchId: randomUUID(), coordinator: native.inspectProcess(child.pid) })
  f.request.checkpoint_sha256 = readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).checkpoint_sha256
  await assert.rejects(launchWorkspaceInterruptedRecoveryCoordinator(f.options()), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
  assert.equal(readWorkspaceInterruptedRecoveryRole(f.data, f.request.recovery_id).launch, null)
  assert.equal(hash(readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).coordinator.launch), hash(original))
  assert.ok(cliLockToken(lock))
})

test('record changes retire the new live role instead of changing its original scope', { timeout: 45000 }, async t => {
  const f = await fixture(t); await acquireWorkspaceRelocationLock(f.data, f.id)
  const role = await launchWorkspaceInterruptedRecoveryCoordinator(f.options()); f.children.push(role)
  // A fixed original record appears after admission; the child must refuse the changed checkpoint.
  const file = path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json')
  const intent = readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).intent
  const body = JSON.stringify({ schema_version: 1, intent_id: f.id, intent_sha256: hash(intent), workers: [], created_at: new Date().toISOString() }) + '\n'
  if (process.platform === 'win32') { native.writePrivateFile(file, body) } else fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' })
  await assert.rejects(role.verify(), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
  assert.equal(fs.readFileSync(file, 'utf8'), body)
})


test('an idle initialized recovery role cannot invent missing execution-exit evidence', { timeout: 45000 }, async t => {
  const f = await fixture(t); await acquireWorkspaceRelocationLock(f.data, f.id)
  const role = await launchWorkspaceInterruptedRecoveryCoordinator(f.options()); f.children.push(role)
  await assert.rejects(role.restoreSource(), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
  const directory = path.join(f.data, 'workspace-control/relocation-recovery', f.request.recovery_id)
  assert.equal(fs.existsSync(path.join(directory, 'source-plan.json')), false)
  assert.equal(fs.existsSync(path.join(directory, 'source-complete.json')), false)
  assert.equal(fs.existsSync(path.join(f.root, 'new')), false)
  assert.equal(readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).execution_exit, null)
})
