import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
