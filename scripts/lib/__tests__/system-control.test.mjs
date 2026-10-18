import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { controlSystemUser, systemctlForUser, parseSystemServiceStatus, reconcileSystemService } from '../system-control.mjs'
import { applySystemUserBinding, ownSystemEntry, systemMaintenanceAllowsServiceStart } from '../system-context.mjs'
import management from '../desktop-management.cjs'
import identity from '../process-identity.cjs'

function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-system-control-')))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const data_dir = management.ensurePrivateDataRoot(path.join(parent, 'data'))
  return { user: 'alice', uid: 1001, gid: 1002, home: '/home/alice', data_dir, port_offset: 100, enabled: true, autostart: false }
}
const running = generation => ({ state: 'running', generation, ready: true }), stopped = { state: 'stopped', generation: null }

test('managed binding refuses foreign environment and authenticates the real OS account', () => {
  const entry = { uid: 1001, user: 'alice', gid: 1002, home: '/home/alice', data_dir: '/srv/alice', port_offset: 100, enabled: true, autostart: false }
  const registry = { read: () => [entry] }
  assert.equal(ownSystemEntry({ registry, account: { uid: 1001, username: 'alice', gid: 1002, homedir: '/home/alice' } }), entry)
  assert.throws(() => ownSystemEntry({ registry, account: { uid: 1001, username: 'mallory', gid: 1002, homedir: '/home/alice' } }))
  for (const env of [{ DATA_DIR: '/root/.crabot/data' }, { CRABOT_PORT_OFFSET: '200' }]) assert.throws(() => applySystemUserBinding(entry, env), { code: 'CRABOT_SYSTEM_BINDING_CONFLICT' })
  const env = {}; applySystemUserBinding(entry, env); assert.equal(env.DATA_DIR, '/srv/alice'); assert.equal(env.HOME, '/home/alice')
})

test('systemctl is fixed to the own-user manager and never starts a root service', async () => {
  const entry = { uid: 1001, user: 'alice', gid: 1002, home: '/home/alice', data_dir: '/srv/alice', port_offset: 100, enabled: true, autostart: false }
  await systemctlForUser(entry, ['start', 'crabot.service'], async (command, args, options) => {
    assert.equal(command, '/usr/bin/systemctl'); assert.deepEqual(args, ['--user', 'start', 'crabot.service'])
    assert.equal(options.env.HOME, '/home/alice'); assert.equal(options.env.XDG_RUNTIME_DIR, '/run/user/1001')
    assert.equal(options.env.NODE_OPTIONS, undefined)
  })
})

test('restart holds its control lock across verified stop and healthy start', async t => {
  const entry = fixture(t), calls = [], observations = [running('old'), running('old'), stopped, running('new')]
  const result = await controlSystemUser(entry, 'restart', running('old'), { available: () => {}, observe: () => observations.shift(), invoke: async (_, args) => {
    calls.push(args[0])
    const other = identity.tryFileLock(path.join(entry.data_dir, 'system-control/cli.lock'), '{}')
    try { assert.equal(other, null, 'same control lock must cover both service steps') } finally { if (other) identity.releaseFileLock(other) }
  } })
  assert.equal(result.state, 'restarted'); assert.equal(result.generation, 'new'); assert.deepEqual(calls, ['stop', 'start'])
})

test('stop failure, unconfirmed exit and replacement generation never dispatch start', async t => {
  const entry = fixture(t)
  for (const mode of ['failure', 'still-running', 'replacement']) {
    const calls = []; let count = 0
    await assert.rejects(controlSystemUser(entry, 'restart', running('old'), { available: () => {}, observe: () => mode === 'replacement' ? running('replacement') : ++count === 1 ? running('old') : running('old'), invoke: async (_, args) => {
      calls.push(args[0]); if (mode === 'failure') throw new Error('stop failed')
    } }))
    assert.equal(calls.includes('start'), false)
  }
})

test('explicitly stopped and already-running users are preserved; global busy dispatches nothing', async t => {
  const entry = fixture(t)
  assert.deepEqual(await controlSystemUser(entry, 'restart', running('old'), { available: () => {}, observe: () => stopped, invoke: () => assert.fail() }), { state: 'skipped', observed_state: 'stopped' })
  assert.deepEqual(await controlSystemUser(entry, 'start', running('old'), { available: () => {}, observe: () => running('old'), invoke: () => assert.fail() }), { state: 'skipped', observed_state: 'running' })
  await assert.rejects(controlSystemUser(entry, 'start', stopped, { available: () => { throw new Error('maintenance busy') }, invoke: () => assert.fail() }), /maintenance busy/)
})

test('startup is not successful until module health is verified', async t => {
  const entry = fixture(t); let calls = 0
  await assert.rejects(controlSystemUser(entry, 'start', stopped, { available: () => {}, waitMs: 0,
    observe: () => ++calls === 1 ? stopped : { ...running('new'), ready: false }, invoke: async () => {} }), { code: 'CRABOT_SYSTEM_START_UNHEALTHY' })
})

test('a live service before MM registration is starting, never falsely stopped', () => {
  const text = 'MainPID=123\nActiveState=active\nTasksCurrent=2\nControlGroup=/user.slice/crabot.service\nInvocationID=' + 'a'.repeat(32) + '\n'
  const service = parseSystemServiceStatus(text), controller = { pid: 123, owner: '1001', started: '123', executable: '/trusted/node' }
  const observed = reconcileSystemService({ state: 'stopped', record: null }, service, controller, 1001)
  assert.equal(observed.state, 'starting'); assert.equal(observed.generation, 'systemd:' + 'a'.repeat(32))
  const running = reconcileSystemService({ state: 'running', record: { generation: 'mm-id', controller } }, service, controller, 1001)
  assert.equal(running.generation, observed.generation, 'service startup to MM registration is the same service generation')
})
test('leftover preparation processes and a mismatched service controller stay unknown', () => {
  const service = { state: 'failed', pid: 0, tasks: 1, group: '/user.slice/crabot.service', invocation: 'a'.repeat(32) }
  assert.throws(() => reconcileSystemService({ state: 'stopped' }, service, null, 1001), { code: 'CRABOT_SYSTEM_SERVICE_UNSETTLED' })
  assert.deepEqual(reconcileSystemService({ state: 'stopped' }, { ...service, tasks: 0 }, null, 1001), { state: 'stopped', generation: null })
  assert.throws(() => reconcileSystemService({ state: 'stopped' }, { ...service, tasks: null }, null, 1001))
  assert.throws(() => parseSystemServiceStatus('ActiveState=active\nMainPID=wrong\nTasksCurrent=1\nInvocationID=\n'))
  assert.throws(() => reconcileSystemService({ state: 'stopped' }, { ...service, pid: 123 }, { owner: '0' }, 1001))
})


test('a deployment service start requires the exact current boot, UID, selected core and service cgroup', () => {
  const record = { schema_version: 1, phase: 'running', operation: 'upgrade', current_uid: 1001,
    boot_id: 'boot-now', allow_start: { uid: 1001, core_id: 'b'.repeat(64) } }
  const context = { entry: { uid: 1001 }, coreId: 'b'.repeat(64), bootId: 'boot-now', cgroup: '0::/user.slice/crabot.service\n' }
  assert.equal(systemMaintenanceAllowsServiceStart(record, context), true)
  for (const change of [{ bootId: 'old-boot' }, { coreId: 'a'.repeat(64) }, { entry: { uid: 1002 } }, { cgroup: '0::/user.slice/other.service' }]) {
    assert.equal(systemMaintenanceAllowsServiceStart(record, { ...context, ...change }), false)
  }
  for (const change of [{ phase: 'completed' }, { allow_start: undefined }, { current_uid: 1002 }]) {
    assert.equal(systemMaintenanceAllowsServiceStart({ ...record, ...change }, context), false)
  }
})


test('a cancelled foreground start does not dispatch a fresh service', async t => {
  const entry = fixture(t), controller = new AbortController(); controller.abort()
  await assert.rejects(controlSystemUser(entry, 'start', stopped, { available: () => {}, observe: async () => stopped,
    signal: controller.signal, invoke: () => assert.fail('cancelled before dispatch') }), { code: 'CRABOT_SYSTEM_START_CANCELLED' })
})


test('a legacy environment alias for the same bound directory is normalized; a retargeted alias is refused', { skip: process.platform === 'win32' }, t => {
  const entry = fixture(t), parent = path.dirname(entry.data_dir), alias = path.join(parent, 'old-home-alias')
  fs.symlinkSync(parent, alias, 'dir')
  const env = { DATA_DIR: path.join(alias, path.basename(entry.data_dir)), CRABOT_PORT_OFFSET: String(entry.port_offset) }
  applySystemUserBinding(entry, env); assert.equal(env.DATA_DIR, entry.data_dir)
  fs.unlinkSync(alias)
  const other = path.join(parent, 'different-root'); fs.mkdirSync(other); fs.mkdirSync(path.join(other, path.basename(entry.data_dir)))
  fs.symlinkSync(other, alias, 'dir')
  assert.throws(() => applySystemUserBinding(entry, { DATA_DIR: path.join(alias, path.basename(entry.data_dir)) }), { code: 'CRABOT_SYSTEM_BINDING_CONFLICT' })
})
