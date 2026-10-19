import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { writeCoreRelease } from '../core-release.mjs'
import { readVersionMaintenance } from '../version-maintenance.mjs'
import { verifyBackup } from '../../upgrade-lib/scoped-data.mjs'
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


test('system first-start module migration uses only its common recovery scope', async t => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'system-scoped-start-')))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const target = path.join(temp, 'target'), dataDir = management.ensurePrivateDataRoot(path.join(temp, 'data'))
  const nodeName = process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node'
  const node = path.join(target, nodeName)
  await fs.mkdir(path.dirname(node), { recursive: true }); await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE)
  if (process.platform !== 'win32') await fs.chmod(node, 0o755)
  await fs.writeFile(path.join(target, 'package.json'), '{"version":"1.2.3"}')
  await fs.writeFile(path.join(target, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch,
    versions: { node: process.versions.node, python: '3.12.12' }, executables: Object.fromEntries(['node', 'python', 'uv', 'bash', 'git', 'rg'].map(name => [name, nodeName])),
    path_entries: ['runtime'], python_home: 'runtime', memory_packages: 'runtime', seed_wheels: [],
    files: { [nodeName]: { size: (await fs.stat(node)).size, sha256: createHash('sha256').update(readFileSync(node)).digest('hex') } } }))
  await fs.mkdir(path.join(target, 'crabot-admin/upgrade'), { recursive: true })
  await fs.writeFile(path.join(target, 'crabot-admin/schema_version'), 'v2')
  await fs.writeFile(path.join(target, 'crabot-admin/upgrade/scope.mjs'), "export const migrationScope = () => ({reads:[],writes:['admin/preferences']})")
  await fs.writeFile(path.join(target, 'crabot-admin/upgrade/from_v1_to_v2.mjs'), "import{writeFileSync}from'node:fs';const dir=process.argv.find(a=>a.startsWith('--data-dir=')).slice(11);writeFileSync(dir+'/preferences','after')")
  await writeCoreRelease(target, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: 'a'.repeat(40), source_dirty: false })
  await fs.mkdir(path.join(dataDir, 'admin')); await fs.writeFile(path.join(dataDir, 'admin/SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(dataDir, 'admin/preferences'), 'before')
  await fs.mkdir(path.join(dataDir, 'agent/traces'), { recursive: true }); await fs.writeFile(path.join(dataDir, 'agent/traces/keep'), 'unrelated')
  const lock = await acquireCliLock(dataDir, 'system-scoped-fixture')
  try { await prepareSystemStartupData({ root: target, dataDir, env: { ...process.env, DATA_DIR: dataDir, PATH: '' } }) }
  finally { releaseCliLock(lock) }
  assert.equal(await fs.readFile(path.join(dataDir, 'admin/preferences'), 'utf8'), 'after')
  assert.equal(await fs.readFile(path.join(dataDir, 'admin/SCHEMA_VERSION'), 'utf8'), 'v2\n')
  assert.equal(await fs.readFile(path.join(dataDir, 'agent/traces/keep'), 'utf8'), 'unrelated')
  assert.equal(readVersionMaintenance(dataDir), null)
  await assert.rejects(fs.lstat(dataDir + '.desktop-backups'), { code: 'ENOENT' })
  const transaction = path.join(dataDir, '.upgrade-migrations/crabot-admin-v1-v2')
  const plan = JSON.parse(await fs.readFile(path.join(transaction, 'plan.json'), 'utf8'))
  await verifyBackup(path.join(transaction, 'backup'), plan.description.scope.writes, plan.original)
  assert.equal(await fs.readFile(path.join(transaction, 'backup/admin/preferences'), 'utf8'), 'before')
  await assert.rejects(fs.lstat(path.join(dataDir, 'mm.pid')), { code: 'ENOENT' })
})
