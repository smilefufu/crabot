import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopController } from '../dist/controller.js'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

test('a stopped GUI observes an externally started shared core without starting it itself', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  let connects = 0
  controller.current = async () => ({ mmAlive: true, record: { generation: 'external-start' } })
  controller.load = async () => { throw new Error('Observation must never load a start/stop adapter') }
  controller.host.reconnect = async () => { connects++ }
  controller.host.status('stopped')
  await controller.reconnectIfChanged()
  assert.equal(connects, 1)
})

test('restoring a stopped GUI while its core remains stopped never starts or authenticates it', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  controller.current = async () => ({ mmAlive: false, record: null })
  controller.load = async () => { throw new Error('Observation must never load a start/stop adapter') }
  controller.host.reconnect = async () => { throw new Error('No core to authenticate') }
  controller.host.status('stopped')
  await controller.reconnectIfChanged()
  assert.equal(controller.host.snapshot().phase, 'stopped')
})

test('a damaged packaged version cannot bypass verification through reconnect or an external CLI start', async t => {
  const controller = new DesktopController({ coreRoot: fileURLToPath(new URL('../..', import.meta.url)), dataRoot: '/unused',
    appVersion: '0.1.0-desktop.2', platform: process.platform, packaged: true })
  t.after(() => controller.close())
  let connects = 0
  controller.current = async () => ({ mmAlive: true, record: { generation: 'external-start' } })
  controller.host.reconnect = async () => { connects++ }
  assert.equal((await controller.start()).phase, 'error')
  assert.equal((await controller.reconnect()).phase, 'error')
  controller.host.status('stopped')
  await controller.reconnectIfChanged()
  assert.equal(controller.host.snapshot().phase, 'error')
  assert.equal(controller.host.snapshot().code, 'CRABOT_CORE_INTEGRITY')
  assert.equal(connects, 0)
})

test('a completed explicit stop invalidates a watcher still verifying the installation', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  let checking, release
  const started = new Promise(resolve => { checking = resolve })
  const verification = new Promise(resolve => { release = resolve })
  controller.verifyInstallation = async () => { checking(); await verification }
  controller.current = async () => ({ mmAlive: true, record: { generation: 'external-start' } })
  controller.load = async file => {
    if (file.endsWith('cli-lock.mjs')) return { acquireCliLock: async () => 'fixture-lock', releaseCliLock: () => {} }
    if (file.endsWith('instance-controller.mjs')) return { stopInstance: async () => {} }
    throw new Error('Unexpected adapter')
  }
  let connects = 0
  controller.host.reconnect = async () => { connects++ }
  controller.host.status('stopped')
  const watching = controller.reconnectIfChanged()
  await started
  assert.equal((await controller.stop()).phase, 'stopped')
  release(); await watching
  assert.equal(controller.host.snapshot().phase, 'stopped')
  assert.equal(connects, 0)
})

test('a stopped host needs settled process records before it can report update-safe inactivity', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-update-activity-'))
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: root, appVersion: 'fixture', platform: process.platform })
  t.after(async () => { controller.close(); await fs.rm(root, { recursive: true, force: true }) })
  controller.current = async () => ({ state: 'stopped', mmAlive: false, record: null })
  controller.host.status('stopped')
  assert.equal(await controller.updateActivity(), 'idle')
  await fs.mkdir(path.join(root, 'module-runtime-registry/records'), { recursive: true })
  await fs.writeFile(path.join(root, 'module-runtime-registry/records/unsettled.json'), '{}')
  assert.equal(await controller.updateActivity(), 'unknown')
  controller.current = async () => { throw new Error('Process ownership unknown') }
  assert.equal(await controller.updateActivity(), 'unknown')
})

test('work which appears before the common update lock is acquired prevents stop, backup and installer writes', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  const calls = []
  controller.current = async () => { calls.push('inspect') }
  controller.updateActivity = async () => { calls.push('activity'); return 'active' }
  controller.load = async file => {
    if (file.endsWith('cli-lock.mjs')) return { acquireCliLock: async () => { calls.push('lock'); return 'fixture' }, releaseCliLock: () => { calls.push('unlock') } }
    const forbidden = () => { throw new Error('Must not mutate after an active/unknown check') }
    return { beginVersionMaintenance: forbidden, stopInstance: forbidden, createMaintenanceBackup: forbidden }
  }
  await assert.rejects(controller.prepareUpdate({ version: '1.2.4' }, async () => { calls.push('install') }), { code: 'CRABOT_UPDATE_BUSY' })
  assert.deepEqual(calls, ['lock', 'inspect', 'activity', 'unlock'])
  assert.equal(controller.host.snapshot().phase, 'error')
})


test('GUI recovery checks backup coverage before its ordinary startup adapter runs', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  const pending = [{ dataDir: '/unused/admin' }], calls = []
  controller.load = async file => {
    if (file.endsWith('version-maintenance.mjs')) return {
      readVersionMaintenance: () => ({}),
      recoverVersionMaintenance: async options => { calls.push('lock'); await options.verifyCompatible(); await options.run() },
    }
    if (file.endsWith('core-preparation.mjs')) return { verifyDataCompatibility: () => { calls.push('compatibility'); return pending } }
    if (file.endsWith('maintenance-backup.mjs')) return { assertLocalMigrationData: async (data, actual) => {
      calls.push('coverage'); assert.equal(data, '/unused'); assert.equal(actual, pending)
      throw Object.assign(new Error('External reference'), { code: 'CRABOT_BACKUP_SCOPE_UNVERIFIED' })
    } }
    throw new Error('Unexpected adapter')
  }
  controller.startCore = async () => { calls.push('start') }
  await assert.rejects(controller.recoverVersion(), { code: 'CRABOT_BACKUP_SCOPE_UNVERIFIED' })
  assert.deepEqual(calls, ['lock', 'compatibility', 'coverage'])
})

test('recovery serializes with GUI stop and start operations while it owns the maintenance transaction', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  const calls = []
  let begin, finish
  const begun = new Promise(resolve => { begin = resolve })
  const barrier = new Promise(resolve => { finish = resolve })
  controller.load = async file => {
    if (file.endsWith('version-maintenance.mjs')) return {
      readVersionMaintenance: () => ({}), recoverVersionMaintenance: async options => {
        calls.push('recover'); begin(); await barrier; await options.verifyCompatible(); assert.equal(await options.run(), true); calls.push('recovered')
      },
    }
    if (file.endsWith('core-preparation.mjs')) return { verifyDataCompatibility: () => [] }
    if (file.endsWith('maintenance-backup.mjs')) return { assertLocalMigrationData: async () => {} }
    if (file.endsWith('cli-lock.mjs')) return { acquireCliLock: async () => 'lock', releaseCliLock: () => {} }
    if (file.endsWith('instance-controller.mjs')) return { stopInstance: async () => { calls.push('stop') } }
    throw new Error('Unexpected adapter')
  }
  controller.current = async () => ({ state: 'stopped' })
  controller.startCore = async () => {
    calls.push('start')
    controller.host.publish({ phase: 'ready', app_version: 'fixture', platform: process.platform,
      instance_id: '1'.repeat(64), generation: '11111111-1111-4111-8111-111111111111', admin_url: 'http://127.0.0.1:3000' })
  }
  const recovery = controller.recoverVersion(); await begun
  const stopping = controller.stop()
  await new Promise(resolve => setImmediate(resolve))
  const before = [...calls]
  finish()
  await recovery; await stopping
  assert.deepEqual(before, ['recover'])
  assert.deepEqual(calls, ['recover', 'start', 'recovered', 'stop'])
  assert.equal(controller.host.snapshot().phase, 'stopped')
})

test('reopening GUI recovery never automatically replays a partially failed data migration', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  const record = { phase: 'installing' }
  let writes = 0
  controller.load = async file => {
    if (file.endsWith('version-maintenance.mjs')) return {
      readVersionMaintenance: () => ({ ...record }), recoverVersionMaintenance: async options => {
        await options.verifyCompatible(); record.phase = 'verifying'; await options.run(); await options.verifyCompatible()
      },
    }
    if (file.endsWith('core-preparation.mjs')) return { verifyDataCompatibility: () => [{ dataDir: '/unused/admin' }] }
    if (file.endsWith('maintenance-backup.mjs')) return { assertLocalMigrationData: async () => {} }
    throw new Error('Unexpected adapter')
  }
  controller.startCore = async () => { writes++; throw Object.assign(new Error('Partial data write'), { code: 'MIGRATION_FAILED' }) }
  await assert.rejects(controller.recoverVersion(), { code: 'MIGRATION_FAILED' })
  assert.equal(record.phase, 'verifying'); assert.equal(writes, 1)
  await assert.rejects(controller.recoverVersion(), { code: 'CRABOT_MIGRATION_INTERRUPTED' })
  assert.equal(writes, 1)
  assert.equal(record.phase, 'verifying')
})

for (const code of ['CRABOT_CORE_INTEGRITY', 'CRABOT_RUNTIME_INVALID']) test('damaged product files identify installer repair while preserving user data: ' + code, t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  controller.load = async () => assert.fail('Presenting a failure must not execute a recovery adapter')
  controller.fail(Object.assign(new Error('/private/path?api_key=must-not-display'), { code }))
  const state = controller.host.snapshot()
  assert.equal(state.phase, 'error'); assert.equal(state.code, code)
  assert.match(state.message, /内置运行文件/); assert.match(state.message, /安装包/); assert.match(state.message, /保留数据/)
  assert.doesNotMatch(state.message, /private|must-not-display/)
})
for (const code of ['CRABOT_PYTHON_ENV_INVALID', 'CRABOT_PYTHON_ENV_MIGRATION_REQUIRED', 'CRABOT_PYTHON_ENV_SELECTION_INVALID']) test('work dependencies are distinguished from product repair without executing a rebuild: ' + code, t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  controller.load = async () => assert.fail('Do not silently rebuild a work environment or discard its dependencies')
  controller.fail(Object.assign(new Error('private-package-list'), { code }))
  const state = controller.host.snapshot()
  assert.equal(state.phase, 'error'); assert.equal(state.code, code)
  assert.match(state.message, /工作用Python环境/); assert.match(state.message, /依赖已保留/); assert.match(state.message, /导出/)
  assert.match(state.message, /不会.*重建/); assert.doesNotMatch(state.message, /private-package/)
})
for (const code of ['CRABOT_BACKUP_SPACE', 'CRABOT_UPDATE_SPACE', 'ENOSPC']) test('insufficient space has an actionable diagnosis without exposing a local path: ' + code, t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  controller.fail(Object.assign(new Error('/private/full-volume'), { code }))
  const state = controller.host.snapshot()
  assert.equal(state.phase, 'error'); assert.equal(state.code, code)
  assert.match(state.message, /磁盘空间不足/); assert.match(state.message, /保留/); assert.doesNotMatch(state.message, /private/)
})
