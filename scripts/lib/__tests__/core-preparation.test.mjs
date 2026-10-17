import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import management from '../desktop-management.cjs'
import { prepareCoreEnvironment, applyStartupMigrations } from '../core-preparation.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'crabot-prepare-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const data = management.ensurePrivateDataRoot(join(root, 'data'))
  return { root, data }
}

test('fresh desktop management is private, idempotent and never creates a browser credential', t => {
  const { root, data } = fixture(t)
  const marker = management.initializeDesktopManagement(data)
  assert.deepEqual(management.initializeDesktopManagement(data), marker)
  const source = { PATH: 'host-tools', NO_PROXY: 'example.test', CRABOT_JWT_SECRET: 'existing-secret', CRABOT_ADMIN_WEB_HOST: '0.0.0.0' }
  const prepared = prepareCoreEnvironment({ root, dataDir: data, source })
  assert.equal(prepared.env.CRABOT_ADMIN_WEB_HOST, '127.0.0.1')
  assert.equal(prepared.env.CRABOT_JWT_SECRET, 'existing-secret')
  assert.ok(prepared.env.NO_PROXY.includes('127.0.0.1'))
  assert.equal(source.NO_PROXY, 'example.test')
  assert.equal(source.DATA_DIR, undefined)
  assert.equal(existsSync(join(data, 'admin', 'credentials.json')), false)
})

test('existing data requires explicit takeover; source CLI environment retains its old network policy', t => {
  const { root, data } = fixture(t)
  mkdirSync(join(data, 'admin')); writeFileSync(join(data, 'admin', 'credentials.json'), 'preserve-old')
  assert.throws(() => management.initializeDesktopManagement(data), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
  writeFileSync(join(root, '.env'), 'CRABOT_JWT_SECRET=file-secret\nCUSTOM=value\n')
  const result = prepareCoreEnvironment({ root, dataDir: data, source: { CUSTOM: 'explicit' } })
  assert.equal(result.managed, null)
  assert.equal(result.env.CRABOT_ADMIN_WEB_HOST, undefined)
  assert.equal(result.env.CUSTOM, 'explicit')
  assert.equal(result.env.CRABOT_JWT_SECRET, 'file-secret')
  assert.equal(readFileSync(join(data, 'admin', 'credentials.json'), 'utf8'), 'preserve-old')
})

test('unknown broad data permissions are not silently changed', { skip: process.platform === 'win32' }, t => {
  const { data } = fixture(t)
  chmodSync(data, 0o755)
  assert.throws(() => management.ensurePrivateDataRoot(data), { code: 'CRABOT_DATA_NOT_PRIVATE' })
})

test('common start migrations preserve success/failure schema settlement without starting a service', async t => {
  const { root, data } = fixture(t)
  const module = join(root, 'crabot-fixture'), moduleData = join(data, 'fixture')
  mkdirSync(join(module, 'upgrade'), { recursive: true }); mkdirSync(moduleData)
  writeFileSync(join(module, 'schema_version'), 'v1')
  writeFileSync(join(moduleData, 'existing.json'), '{}')
  const script = join(module, 'upgrade', 'from_v0_to_v1.mjs')
  writeFileSync(script, 'process.exit(1)')
  await assert.rejects(applyStartupMigrations(root, data, process.env), { code: 'CRABOT_MIGRATION_FAILED' })
  assert.equal(existsSync(join(moduleData, 'SCHEMA_VERSION')), false)
  writeFileSync(script, 'process.exit(0)')
  await applyStartupMigrations(root, data, process.env)
  assert.equal(readFileSync(join(moduleData, 'SCHEMA_VERSION'), 'utf8'), 'v1\n')
  await applyStartupMigrations(root, data, process.env)
  assert.equal(existsSync(join(data, 'mm.pid')), false)
})

test('an older core cannot relabel newer data or begin any forward migration', async t => {
  const { root, data } = fixture(t)
  for (const name of ['a-forward', 'z-newer']) {
    mkdirSync(join(root, 'crabot-' + name, 'upgrade'), { recursive: true })
    mkdirSync(join(data, name)); writeFileSync(join(data, name, 'existing.json'), '{}')
    writeFileSync(join(root, 'crabot-' + name, 'schema_version'), 'v1')
  }
  writeFileSync(join(data, 'z-newer/SCHEMA_VERSION'), 'v2\n')
  writeFileSync(join(root, 'crabot-a-forward/upgrade/from_v0_to_v1.mjs'),
    'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2].slice("--data-dir=".length) + "/must-not-run", "changed")')
  await assert.rejects(applyStartupMigrations(root, data, process.env), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
  assert.equal(readFileSync(join(data, 'z-newer/SCHEMA_VERSION'), 'utf8'), 'v2\n')
  assert.equal(existsSync(join(data, 'a-forward/SCHEMA_VERSION')), false)
  assert.equal(existsSync(join(data, 'a-forward/must-not-run')), false)
})


test('versioned CLI reads container environment without editing payloads and refuses an obsolete version before data writes', t => {
  const f = fixture(t), id = 'a'.repeat(64), core = join(f.root, 'releases', id), files = {}, executables = {}
  mkdirSync(core, { recursive: true })
  writeFileSync(join(f.root, 'cli-installation.json'), JSON.stringify({ schema_version: 1, scope: 'user', launcher_sha256: 'b'.repeat(64) }))
  writeFileSync(join(f.root, 'current-core'), id + '\n')
  writeFileSync(join(core, 'core-release.json'), JSON.stringify({ inventory_sha256: id }))
  writeFileSync(join(f.root, '.env'), 'CUSTOM=from-container\nCRABOT_JWT_SECRET=preserved-file-secret\n')
  for (const name of ['node', 'python', 'uv', 'bash', 'git', 'rg']) {
    const relative = 'runtime/bin/' + name, content = 'fixture-' + name
    mkdirSync(join(core, 'runtime/bin'), { recursive: true }); writeFileSync(join(core, relative), content, { mode: 0o755 })
    executables[name] = relative; files[relative] = { size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }
  }
  for (const name of ['python', 'memory']) mkdirSync(join(core, 'runtime', name))
  writeFileSync(join(core, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch,
    versions: { python: '3.12.12', node: '22.22.3' }, executables, files, path_entries: ['runtime/bin'], python_home: 'runtime/python', memory_packages: 'runtime/memory', seed_wheels: [] }))
  const result = prepareCoreEnvironment({ root: core, dataDir: f.data, source: { CUSTOM: 'explicit' } })
  assert.equal(result.env.CUSTOM, 'explicit'); assert.equal(result.env.CRABOT_JWT_SECRET, 'preserved-file-secret')
  assert.equal(existsSync(join(core, '.env')), false)
  writeFileSync(join(f.root, 'current-core'), 'c'.repeat(64) + '\n')
  const untouched = join(f.root, 'uncreated-data')
  assert.throws(() => prepareCoreEnvironment({ root: core, dataDir: untouched, source: {} }), { code: 'CRABOT_CLI_INSTALLATION' })
  assert.equal(existsSync(untouched), false)
})
