import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { prepareSystemStartupData } from '../system-startup-data.mjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { verifyDataCompatibility } from '../core-preparation.mjs'
import management from '../desktop-management.cjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
test('system start prepares request authority even when every module schema already matches', async t => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'system-request-start-')))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const dataDir = management.ensurePrivateDataRoot(path.join(temp, 'data'))
  await fs.mkdir(path.join(dataDir, 'agent/worker-ledgers'), { recursive: true })
  const ledger = path.join(dataDir, 'agent/worker-ledgers/channel%3A%3Agroup.json')
  const original = { manager_key: 'channel::group', workers: [] }
  await fs.writeFile(ledger, JSON.stringify(original))
  assert.deepEqual(verifyDataCompatibility(root, dataDir), [])
  const lock = await acquireCliLock(dataDir, 'system-start-fixture')
  try { await prepareSystemStartupData({ root, dataDir, env: { ...process.env, DATA_DIR: dataDir } }) }
  finally { releaseCliLock(lock) }
  const ready = JSON.parse(await fs.readFile(path.join(dataDir, 'agent/shared-request-upgrade.json'), 'utf8'))
  assert.equal(ready.status, 'ready'); assert.equal(ready.schema_version, 2)
  const wrapped = JSON.parse(await fs.readFile(ledger, 'utf8'))
  assert.equal(wrapped.schema_version, 1); assert.deepEqual(wrapped.ledger, original)
  await assert.rejects(fs.stat(path.join(dataDir, 'mm.pid')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(dataDir + '.desktop-backups'), { code: 'ENOENT' })
})
