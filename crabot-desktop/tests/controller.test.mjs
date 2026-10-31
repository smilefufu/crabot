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

async function pairedController(t, failure, commitBarrier) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'paired-controller-')))
  const uuid = '11111111-1111-4111-8111-111111111111'
  const source = { schema_version: 1, version: '1.2.3', gui_id: uuid, core_id: 'a'.repeat(64) }
  const target = { schema_version: 1, version: '1.2.4', gui_id: '22222222-2222-4222-8222-222222222222', core_id: 'b'.repeat(64) }
  const sourceRoot = path.join(root, 'releases', source.core_id), targetRoot = path.join(root, 'releases', target.core_id), dataDir = path.join(root, 'data')
  const prepared = { installRoot: root, installation_id: uuid, source, selection: target, coreRoot: targetRoot,
    guiRoot: path.join(root, 'app/releases', target.gui_id), proof: { file: path.join(root, 'app/payloads', target.gui_id + '.json'), sha256: 'c'.repeat(64) } }
  const own = { root, coreRoot: sourceRoot, dataDir, record: { installation_id: uuid }, selection: source }
  const controller = new DesktopController({ coreRoot: sourceRoot, dataRoot: dataDir, appVersion: source.version, platform: process.platform })
  t.after(async () => { controller.close(); await fs.rm(root, { recursive: true, force: true }) })
  const calls = [], imports = []
  let verified = false, locked = false, record, converted = false, selection = source
  controller.current = async () => { calls.push('inspect'); return { state: 'stopped', mmAlive: false } }
  controller.updateActivity = async () => { calls.push('activity'); return failure === 'active' ? 'active' : failure === 'unknown' ? 'unknown' : 'idle' }
  controller.load = async (file, requestedRoot = sourceRoot) => {
    imports.push({ file, root: requestedRoot })
    if (requestedRoot === targetRoot) assert.equal(verified, true, 'target code must not execute before full proof')
    if (file.endsWith('desktop-pair-preparation.mjs')) return { verifyPreparedDesktopPair: async actual => {
      calls.push('proof'); assert.equal(actual, prepared)
      if (failure === 'proof') throw Object.assign(new Error('bad payload'), { code: 'CRABOT_CORE_INTEGRITY' })
      verified = true
      return failure === 'source-mismatch' ? { ...own, coreRoot: '/another-source' } : own
    } }
    if (file.endsWith('desktop-installation.cjs')) return { default: { readDesktopSelection: () => { calls.push('source'); return { ...own, selection } } } }
    if (file.endsWith('cli-lock.mjs')) return { acquireCliLock: async actual => {
      calls.push('lock'); assert.equal(actual, dataDir); locked = true; return 'target-data-lock'
    }, releaseCliLock: actual => { calls.push('unlock'); assert.equal(actual, 'target-data-lock'); locked = false } }
    if (file.endsWith('maintenance-backup.mjs')) return { inspectLocalMigrationData: async (actual, pending, core) => {
      calls.push('preflight'); assert.equal(locked, true); assert.equal(actual, dataDir); assert.deepEqual(pending, []); assert.equal(core, targetRoot)
      if (failure === 'preflight') throw Object.assign(new Error('uncovered data'), { code: 'CRABOT_BACKUP_SCOPE_UNVERIFIED' })
    } }
    if (file.endsWith('instance-controller.mjs')) return { stopInstance: async actual => {
      calls.push('stop'); assert.equal(locked, true); assert.equal(actual, dataDir)
      if (failure === 'stop') throw new Error('not stopped')
      if (failure === 'source-after-stop') selection = { ...source, gui_id: target.gui_id }
    } }
    if (file.endsWith('core-preparation.mjs')) return {
      verifyDataCompatibility: () => failure === 'completion' && converted ? ['not completed'] : [],
      applyStartupMigrations: async (actualRoot, actualData, env) => {
        calls.push('run'); assert.equal(locked, true); assert.equal(record.phase, 'verifying')
        assert.equal(actualRoot, targetRoot); assert.equal(actualData, dataDir)
        assert.equal(env.DATA_DIR, dataDir); assert.equal(env.CRABOT_HOME, targetRoot); assert.equal(env.CRABOT_PRODUCT_REQUIRED, '1')
        converted = true
        if (failure === 'migration') throw Object.assign(new Error('unconfirmed conversion'), { code: 'CRABOT_MIGRATION_INTERRUPTED' })
      },
    }
    if (file.endsWith('upgrade-lib/migrate.mjs')) return { previewMigrations: async () => ({ modules: [], shared: { status: 'ready' } }) }
    if (file.endsWith('version-maintenance.mjs')) return {
      readVersionMaintenance: () => record ?? null,
      beginVersionMaintenance: async (actualData, from, toVersion, fromVersion, options) => {
        calls.push('begin'); assert.equal(locked, true); assert.equal(actualData, dataDir); assert.equal(from, sourceRoot)
        assert.equal(toVersion, target.version); assert.equal(fromVersion, source.version); assert.deepEqual(options, { dataProtection: 'scoped' })
        if (record) throw Object.assign(new Error('pending maintenance'), { code: 'CRABOT_MAINTENANCE_PENDING' })
        return record = { id: uuid, phase: 'preparing' }
      }, bindVersionMaintenanceTarget: async (actual, id, core) => { calls.push('bind'); assert.equal(core, targetRoot); return record },
      prepareScopedVersionMaintenance: async () => { calls.push('prepare'); record.phase = 'prepared'; return record },
      markVersionMaintenanceInstalling: async () => { calls.push('installing'); record.phase = 'installing' },
      migrateStoppedVersionMaintenance: async options => {
        calls.push('migrate'); record.phase = 'verifying'; await options.migrate(); await options.verifyComplete(); calls.push('migrated')
      },
    }
    if (file.endsWith('desktop-pair-commit.mjs')) return { commitPreparedDesktopPair: async (actual, options) => {
      calls.push('commit'); assert.equal(locked, false, 'release data before commit acquires root then data')
      assert.equal(record.phase, 'verifying'); assert.equal(actual, prepared); assert.equal(options.maintenanceId, record.id)
      if (commitBarrier) await commitBarrier()
      if (failure === 'commit') throw new Error('pair commit not confirmed')
      assert.equal(await options.verifyData(), true); await options.replaceEntries(own, prepared)
      return { executable: path.join(prepared.guiRoot, 'fixture-never-executed'), dataDir }
    } }
    throw new Error('Unexpected adapter: ' + file)
  }
  return { controller, prepared, calls, imports, targetRoot, record: () => record,
    run: () => controller.applyPreparedPair(prepared, async () => { calls.push('entries') }) }
}
test('paired GUI update verifies before target imports and uses target locked migration without a broad backup or startup', async t => {
  const f = await pairedController(t)
  const result = await f.run()
  assert.ok(result.executable.endsWith('fixture-never-executed'))
  assert.deepEqual(f.calls, ['proof', 'lock', 'source', 'inspect', 'preflight', 'activity', 'source', 'inspect', 'begin', 'bind', 'stop', 'source', 'prepare', 'installing', 'migrate', 'run', 'migrated', 'unlock', 'commit', 'entries'])
  assert.equal(f.record().phase, 'verifying')
  assert.equal(f.controller.host.snapshot().phase, 'stopped')
  assert.equal(f.imports.find(item => item.file.endsWith('version-maintenance.mjs')).root, f.targetRoot)
  assert.equal(f.imports.find(item => item.file.endsWith('cli-lock.mjs')).root, f.targetRoot)
})
for (const failure of ['proof', 'source-mismatch', 'preflight', 'active', 'unknown', 'stop', 'source-after-stop', 'migration', 'completion', 'commit']) {
  test('paired GUI update preserves its boundary on failure: ' + failure, async t => {
    const f = await pairedController(t, failure)
    await assert.rejects(f.run())
    assert.equal(f.controller.host.snapshot().phase, 'error')
    if (['proof', 'source-mismatch', 'preflight', 'active', 'unknown'].includes(failure)) {
      assert.equal(f.calls.includes('begin'), false); assert.equal(f.calls.includes('stop'), false)
    }
    if (['proof', 'source-mismatch'].includes(failure)) assert.equal(f.imports.some(item => item.root === f.targetRoot), false)
    if (['stop', 'source-after-stop'].includes(failure)) assert.equal(f.calls.includes('migrate'), false)
    if (['migration', 'completion'].includes(failure)) {
      assert.equal(f.record().phase, 'verifying'); assert.equal(f.calls.includes('commit'), false)
      await assert.rejects(f.run()); assert.equal(f.calls.filter(item => item === 'run').length, 1)
    }
    if (failure === 'commit') { assert.equal(f.record().phase, 'verifying'); assert.equal(f.calls.includes('entries'), false) }
  })
}
test('paired commit serializes later GUI stop and keeps its watcher suspended until completion', async t => {
  let entered, release
  const begun = new Promise(resolve => { entered = resolve }), barrier = new Promise(resolve => { release = resolve })
  const f = await pairedController(t, undefined, async () => { entered(); await barrier })
  const updating = f.run(); await begun
  const stopping = f.controller.stop()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.filter(item => item === 'stop').length, 1)
  assert.equal(f.controller.busy, 2)
  release(); await updating; await stopping
  assert.equal(f.calls.filter(item => item === 'stop').length, 2)
  assert.ok(f.calls.lastIndexOf('stop') > f.calls.indexOf('entries'))
})

for (const fail of [false, true]) test('bound login intent is captured before the shared service stops: ' + fail, async t => {
  const f = await pairedController(t)
  f.controller.options.loginStartup = { captureForUpdate: async () => 'off' }
  f.controller.captureLoginStartup = async (prepared, id) => {
    assert.equal(prepared, f.prepared); assert.equal(id, f.record().id)
    assert.equal(f.record().phase, 'preparing')
    assert.equal(f.calls.includes('stop'), false)
    assert.equal(f.calls.includes('unlock'), false)
    f.calls.push('login-capture')
    if (fail) throw new Error('Unknown OS entry')
  }
  if (fail) {
    await assert.rejects(f.run(), /Unknown OS entry/)
    assert.equal(f.calls.includes('stop'), false); assert.equal(f.calls.includes('migrate'), false)
    assert.equal(f.record().phase, 'preparing'); assert.equal(f.calls.at(-1), 'unlock')
  } else {
    await f.run()
    assert.ok(f.calls.indexOf('login-capture') > f.calls.indexOf('bind'))
    assert.ok(f.calls.indexOf('login-capture') < f.calls.indexOf('stop'))
  }
})

test('target login recovery stays inside compatible-data recovery before the health gate', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform,
    loginStartup: { captureForUpdate: async () => 'off', restoreForUpdate: async () => assert.fail('No OS mutation in this orchestration fixture') } })
  t.after(() => controller.close())
  const calls = []
  controller.load = async file => {
    if (file.endsWith('version-maintenance.mjs')) return {
      readVersionMaintenance: () => ({ id: 'current' }), recoverVersionMaintenance: async options => {
        calls.push('lock'); await options.verifyCompatible(); assert.equal(await options.run(), false); calls.push('health-failed')
      },
    }
    if (file.endsWith('core-preparation.mjs')) return { verifyDataCompatibility: () => { calls.push('compatibility'); return [] } }
    if (file.endsWith('maintenance-backup.mjs')) return { assertLocalMigrationData: async () => { calls.push('coverage') } }
    throw new Error('Unexpected adapter')
  }
  controller.recoverLoginStartup = async () => { calls.push('login') }
  controller.startCore = async () => { calls.push('start'); controller.host.status('error') }
  await controller.recoverVersion()
  assert.deepEqual(calls, ['lock', 'compatibility', 'coverage', 'login', 'start', 'health-failed'])
})

for (const source of [true, false]) test('source recovery and old target jobs do not create or replay login intent: ' + source, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'login-no-replay-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let os = 0, notices = 0
  const controller = new DesktopController({ coreRoot: '/target', dataRoot: '/data', appVersion: '1.2.4', platform: process.platform,
    loginStartup: { captureForUpdate: async () => { os++; return 'on' }, restoreForUpdate: async () => { os++; throw new Error('No intent') } },
    loginStartupRecovered: () => { notices++ } })
  t.after(() => controller.close())
  controller.load = async file => {
    if (file.endsWith('version-maintenance.mjs')) return { readVersionMaintenance: () => ({ schema_version: 3, phase: 'verifying',
      id: '11111111-1111-4111-8111-111111111111', install_root: source ? '/target' : '/source', target_core: { root: '/target' } }) }
    if (file.endsWith('desktop-installation.cjs')) return { default: { locateDesktopCore: () => ({ root, dataDir: '/data' }) } }
    assert.fail('No old job scan, proof replay or start/stop import: ' + file)
  }
  await controller.recoverLoginStartup()
  assert.equal(os, 0); assert.equal(notices, 0); assert.deepEqual(await fs.readdir(root), [])
})

for (const health of [false, true]) for (const noticeThrows of [false, true]) test('an unconfirmed login recovery cannot clear or fake business health: ' + health + ', notice throws: ' + noticeThrows, async t => {
  const calls = [], notices = []
  const controller = new DesktopController({ coreRoot: '/target', dataRoot: '/data', appVersion: '1.2.4', platform: process.platform,
    loginStartup: { captureForUpdate: async () => assert.fail('No capture'), restoreForUpdate: async () => assert.fail('Unverified OS operation') },
    loginStartupRecovered: state => { calls.push('notice'); notices.push(state); if (noticeThrows) throw new Error('Presentation failed') } })
  t.after(() => controller.close())
  controller.load = async file => {
    if (file.endsWith('version-maintenance.mjs')) return {
      readVersionMaintenance: () => ({ schema_version: 3, phase: 'verifying', install_root: '/source', target_core: { root: '/target' } }),
      recoverVersionMaintenance: async options => {
        calls.push('lock'); await options.verifyCompatible()
        if (!await options.run()) throw Object.assign(new Error('Health unconfirmed'), { code: 'CRABOT_MAINTENANCE_PENDING' })
        await options.verifyCompatible(); calls.push('clear')
      },
    }
    if (file.endsWith('core-preparation.mjs')) return { verifyDataCompatibility: () => { calls.push('compatibility'); return [] } }
    if (file.endsWith('maintenance-backup.mjs')) return { assertLocalMigrationData: async () => { calls.push('coverage') } }
    if (file.endsWith('desktop-installation.cjs')) throw new Error('Login installation unconfirmed')
    assert.fail('Unexpected adapter: ' + file)
  }
  controller.startCore = async () => {
    calls.push('start')
    if (health) controller.host.publish({ phase: 'ready', app_version: '1.2.4', platform: process.platform,
      instance_id: '1'.repeat(64), generation: '11111111-1111-4111-8111-111111111111', admin_url: 'http://127.0.0.1:3000' })
    else controller.host.status('error')
  }
  if (health) await controller.recoverVersion()
  else await assert.rejects(controller.recoverVersion(), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.deepEqual(notices, [null]); assert.equal(calls.includes('start'), true)
  assert.equal(calls.includes('clear'), health)
  assert.ok(calls.indexOf('notice') > calls.indexOf('start'), 'A native notice must not precede service recovery')
  if (health) assert.ok(calls.indexOf('notice') > calls.indexOf('clear'), 'A native notice must not block health finalization')
  assert.equal(calls.filter(item => item === 'compatibility').length, health ? 2 : 1)
})

for (const outcome of ['ready', 'cli-failed', 'pending-data']) test('schema4 GUI recovery uses dedicated admission and waits for CLI proof: ' + outcome, async t => {
  const calls = [], controller = new DesktopController({ coreRoot: '/target', dataRoot: '/data', appVersion: '1.2.4', platform: process.platform,
    verifyBinding: () => calls.push('binding') })
  t.after(() => controller.close())
  controller.load = async file => {
    if (file.endsWith('version-maintenance.mjs')) return {
      readVersionMaintenance: () => ({ schema_version: 4, phase: 'verifying' }),
      recoverVersionMaintenance: () => assert.fail('The ordinary updater cannot admit a legacy takeover'),
      recoverLegacyUserVersionMaintenance: async options => {
        calls.push('lock'); await options.verifyTakeover(); await options.verifyCompatible()
        if (!await options.run()) throw new Error('No health')
        await options.verifyCompatible(); calls.push('clear')
      },
    }
    if (file.endsWith('core-preparation.mjs')) return { verifyDataCompatibility: () => outcome === 'pending-data' ? ['fixture'] : [] }
    if (file.endsWith('maintenance-backup.mjs')) return { assertLocalMigrationData: async () => { calls.push('coverage') } }
    assert.fail('Unexpected adapter: ' + file)
  }
  controller.startCore = async () => {
    calls.push('start')
    controller.host.publish({ phase: 'ready', app_version: '1.2.4', platform: process.platform,
      instance_id: '1'.repeat(64), generation: '11111111-1111-4111-8111-111111111111', admin_url: 'http://127.0.0.1:3000' })
  }
  controller.verifyLegacyCli = async () => {
    calls.push('cli')
    if (outcome === 'cli-failed') throw Object.assign(new Error('CLI is unconfirmed'), { code: 'CRABOT_MAINTENANCE_PENDING' })
  }
  if (outcome === 'ready') { assert.equal(await controller.recoverVersion(), true); assert.ok(calls.indexOf('cli') < calls.indexOf('clear')) }
  else await assert.rejects(controller.recoverVersion(), { code: outcome === 'pending-data' ? 'CRABOT_MIGRATION_INTERRUPTED' : 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(calls.includes('clear'), outcome === 'ready')
  assert.equal(calls.includes('start'), outcome !== 'pending-data')
  assert.equal(calls.includes('binding'), true)
})


for (const changed of ['mm-missing', 'generation-mismatch', 'not-ready']) test('legacy CLI health never probes an unconfirmed GUI/MM context: ' + changed, async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: '1.2.4', platform: process.platform })
  t.after(() => controller.close())
  const generation = '11111111-1111-4111-8111-111111111111'
  if (changed !== 'not-ready') controller.host.publish({ phase: 'ready', app_version: '1.2.4', platform: process.platform,
    instance_id: '1'.repeat(64), generation, admin_url: 'http://127.0.0.1:3000' })
  controller.current = async () => ({ mmAlive: changed !== 'mm-missing', record: { generation: changed === 'generation-mismatch' ? 'another-generation' : generation } })
  controller.load = () => assert.fail('No installation lookup or CLI spawn before native GUI/MM confirmation')
  await assert.rejects(controller.verifyLegacyCli(), { code: 'CRABOT_MAINTENANCE_PENDING' })
})

test('a port conflict reports its actual port without exposing raw error text or stopping another deployment', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  controller.load = async () => { throw new Error('Conflict reporting must not load a stop adapter') }
  controller.startCore = async () => { throw Object.assign(new Error('private backend details'), { code: 'CRABOT_PORT_BUSY', port: 19000 }) }
  const state = await controller.start()
  assert.equal(state.phase, 'error'); assert.equal(state.code, 'CRABOT_PORT_BUSY')
  assert.match(state.message, /19000.*占用/); assert.equal(state.message.includes('private backend details'), false)
})
