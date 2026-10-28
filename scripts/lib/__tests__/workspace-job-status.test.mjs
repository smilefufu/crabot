import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import syncFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import native from '../process-identity.cjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import * as records from '../workspace-relocation-intent.mjs'

async function fixture(t, active = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-job-read-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), catalog = new WorkspaceCatalog({ dataRoot: data, files: native })
  await catalog.initialize(); const snapshot = await catalog.snapshot(), target = path.join(root, 'next')
  await fs.writeFile(path.join(snapshot.storage_root, 'kept'), 'private business bytes')
  let intent
  if (active) {
    const lock = await acquireCliLock(data, 'workspace-relocation')
    try { intent = await records.beginWorkspaceRelocationIntent({ dataDir: data, id: randomUUID(), target,
      expectedRevision: snapshot.revision, protectedRoots: [path.join(data, 'workspace-control')] }) }
    finally { releaseCliLock(lock) }
  }
  return { root, data, snapshot, target, intent }
}
test('an authenticated adapter can observe no current or requested job without creating records', async t => {
  const f = await fixture(t), control = path.join(f.data, 'workspace-control'), before = await fs.readdir(control), dataBefore = await fs.readdir(f.data)
  assert.equal(typeof records.readWorkspaceRelocationJobStatus, 'function')
  assert.deepEqual(records.readWorkspaceRelocationJobStatus(f.data), { available: true, job: null })
  assert.deepEqual(records.readWorkspaceRelocationJobStatus(f.data, randomUUID()), { available: true, job: null })
  assert.deepEqual(await fs.readdir(control), before); assert.deepEqual(await fs.readdir(f.data), dataBefore)
})
test('an original intent without a current owner is an interrupted observation, never a running or accepted permit', async t => {
  const f = await fixture(t, true), file = path.join(f.data, 'workspace-control/relocation-active/relocation.json')
  const before = await fs.readFile(file), catalogFile = path.join(f.data, 'workspace-control/catalog.json'), catalog = await fs.readFile(catalogFile)
  const read = syncFs.readFileSync
  t.mock.method(syncFs, 'readFileSync', (file, ...args) => {
    assert.notEqual(path.resolve(String(file)), path.join(f.snapshot.storage_root, 'kept'), 'Status must not read business file contents')
    return read(file, ...args)
  })
  const expected = { available: true, job: { intent_id: f.intent.id, state: 'needs_attention', stage: 'unknown', source: f.snapshot.storage_root, target: f.target } }
  assert.deepEqual(records.readWorkspaceRelocationJobStatus(f.data), expected)
  assert.deepEqual(records.readWorkspaceRelocationJobStatus(f.data, f.intent.id), expected)
  assert.deepEqual(records.readWorkspaceRelocationJobStatus(f.data, randomUUID()), { available: true, job: null })
  assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readFile(catalogFile), catalog)
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' })
})
test('damaged or unattributable maintenance never becomes an empty or completed job and is left untouched', async t => {
  const f = await fixture(t, true), file = path.join(f.data, 'workspace-control/relocation-active/relocation.json')
  await fs.writeFile(file, 'damaged original record')
  assert.deepEqual(records.readWorkspaceRelocationJobStatus(f.data), { available: false, job: null })
  assert.deepEqual(await fs.readFile(file, 'utf8'), 'damaged original record')
  const empty = await fixture(t), old = path.join(empty.data, 'workspace-control/relocation.json')
  await fs.writeFile(old, 'unattributable old protection')
  assert.deepEqual(records.readWorkspaceRelocationJobStatus(empty.data), { available: false, job: null })
  assert.deepEqual(await fs.readFile(old, 'utf8'), 'unattributable old protection')
})
