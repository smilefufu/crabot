import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { SystemRegistry } from '../system-registry.mjs'
import { SystemOperationStore } from '../system-operation.mjs'
import { createLegacySystemConversionPermit } from '../system-conversion-permit.mjs'
import { planSystemConversion } from '../system-conversion.mjs'
import { systemConversionOperations, systemConversionRecoveryOperations } from '../system-conversion-job.mjs'
import { LegacySystemEntryFence } from '../legacy-system-fence.mjs'
import { LegacySystemCommandLink } from '../legacy-system-command.mjs'
import { discoverLegacySystemRelease } from '../legacy-system-release.mjs'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
const options = { skip: process.platform === 'win32' }
async function fixture(t, { failure, nested = false } = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-conversion-wiring-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const source = path.join(parent, 'old'), install = nested ? path.join(source, '.managed') : path.join(parent, 'managed'), staging = path.join(install, 'staging')
  const metadata = path.join(parent, 'system'), commandFile = path.join(parent, 'bin/crabot')
  for (const name of [source, staging, path.join(install, 'releases'), path.join(install, 'bin'), path.dirname(commandFile)]) await fs.mkdir(name, { recursive: true })
  await materializeLegacyRelease(source)
  const policy = { ownerUid: process.getuid(), platform: 'linux', checkRoot: () => {} }
  const release = await discoverLegacySystemRelease({ root: source, ...policy })
  for (const name of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(staging, name), '{"version":"1.2.4"}')
  await writeCoreRelease(staging, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const target = await verifyCoreRelease(staging), core = path.join(install, 'releases', target.inventory_sha256)
  await fs.rename(staging, core)
  const launcher = 'controlled target, never executed'
  await fs.writeFile(path.join(install, 'bin/crabot'), launcher, { mode: 0o755 })
  await fs.writeFile(path.join(install, 'cli-installation.json'), JSON.stringify({ schema_version: 1, scope: 'system', launcher_sha256: createHash('sha256').update(launcher).digest('hex') }))
  await fs.writeFile(path.join(install, 'current-core'), target.inventory_sha256 + '\n')
  await fs.symlink(path.join(source, 'cli.mjs'), commandFile)
  const instances = [1001, 1002].map((uid, index) => {
    const entry = { user: 'employee' + uid, uid, gid: uid, home: '/home/employee' + uid,
      data_dir: path.join(parent, 'must-not-access-data-' + uid), port_offset: 100 + index * 100, enabled: true, autostart: false }
    const running = index === 0, observation = { uid, user: entry.user, port_offset: entry.port_offset,
      data_dir: entry.data_dir, data_directory: { device: '1', inode: String(uid) }, install_root: source,
      code_fingerprint: release.code_fingerprint, manifest_fingerprint: 'a'.repeat(64), runtime_state: running ? 'running' : 'stopped', data_binding: running ? 'observed_running' : 'verified_stopped' }
    if (running) Object.assign(observation, { controller: { pid: 51001, parent: 1, owner: String(uid), started: 'old-controller', executable: '/usr/bin/node' },
      mm: { pid: 51002, parent: 51001, owner: String(uid), started: 'old-mm', executable: '/usr/bin/node' }, mm_port: 19100, launch_kind: 'daemon' })
    return { entry, observation }
  })
  const plan = planSystemConversion({ installRoot: install, source: release, target: { id: target.inventory_sha256, version: target.version }, instances })
  const registry = new SystemRegistry({ directory: metadata, ownerUid: process.getuid(), accountLookup: user => {
    const { uid, gid, home } = instances.find(item => item.entry.user === user).entry; return { uid, gid, home, user }
  } })
  await registry.update(() => [], { create: true })
  const store = new SystemOperationStore(registry), calls = [], fence = new LegacySystemEntryFence(policy)
  const command = new LegacySystemCommandLink({ command: commandFile, directory: metadata, ...policy })
  let running = true
  const dependencies = { root: core, registry, fence, command,
    prepare: async () => { calls.push('prepare-services') },
    processes: (directory, options) => { assert.equal(directory, source); assert.deepEqual(options, { trustedTargetRoot: install }); return running ? [instances[0].observation.controller, instances[0].observation.mm].map(process => ({ process, uses_source: true })) : [] },
    legacy: async (entry, request) => {
      const action = request.action, phase = (await fence.inspect(source)).phase
      const bootId = randomUUID(), record = structuredClone(store.read(store.file(plan.id), true)), maintenance = structuredClone(store.maintenance())
      record.boot_id = bootId; maintenance.boot_id = bootId
      const permit = createLegacySystemConversionPermit({ record, maintenance, entry, bootId, action, sourceFence: await fence.inspect(source) })
      assert.equal(permit.action, action)
      assert.equal(phase, action === 'start-legacy' ? 'restored' : ['migrate', 'check-migration'].includes(action) ? 'data_changing' : 'fenced')
      assert.deepEqual(request, { root: core, operationId: plan.id, action })
      calls.push(action + ':' + entry.uid)
      if (failure === action + ':' + entry.uid) throw new Error('controlled role failure')
      if (action === 'stop-legacy') { running = false; return { state: 'stopped', request_acknowledged: true } }
      if (action === 'snapshot') return { id: randomUUID(), system_operation_id: plan.id, target_id: plan.target.id, backup: { id: randomUUID(), sha256: 'd'.repeat(64) } }
      if (action === 'check-migration') return { verified: true, service_started: false }
      if (action === 'migrate') return { migrated: true, service_started: false }
      if (action === 'start-legacy') return { state: 'started' }
      assert.equal(action, 'cancel-preparation'); return { cancelled: true }
    },
    target: async (entry, request) => {
      calls.push(request.action + ':' + entry.uid)
      assert.ok(registry.read().some(value => value.uid === entry.uid))
      if (request.action === 'inspect') return { state: 'stopped' }
      if (request.action === 'start') return { state: 'started', generation: randomUUID() }
      assert.equal(request.action, 'configure-service'); return { configured: true }
    },
  }
  const run = async () => { const conversion = await systemConversionOperations(plan, dependencies); await store.prepare(plan); return store.run(plan.id, { conversion }) }
  return { parent, source, core, registry, store, plan, fence, command, dependencies, calls, run }
}
test('filesystem metadata coordinator connects fenced source, all backups, atomic command switch and per-UID registration without opening employee data', options, async t => {
  const f = await fixture(t, { nested: true })
  f.dependencies.root += path.sep // system-job's file URL directory retains this separator.
  const result = await f.run()
  assert.equal(result.exit_code, 0); assert.equal(await f.command.selected(f.plan), 'target')
  assert.equal((await f.fence.inspect(f.source)).phase, 'data_changing')
  assert.deepEqual(f.calls, ['prepare-services', 'stop-legacy:1001', 'snapshot:1001', 'snapshot:1002',
    'migrate:1001', 'configure-service:1001', 'start:1001', 'migrate:1002', 'configure-service:1002', 'inspect:1002'])
  assert.deepEqual(result.results.map(row => row.state), ['healthy', 'kept_stopped'])
  assert.equal(f.registry.read().length, 2)
  for (const { entry } of f.plan.instances) await assert.rejects(fs.lstat(entry.data_dir), { code: 'ENOENT' })
})
test('pre-data backup failure cancels every dispatched preparation and restores only the original running set through its dedicated role', options, async t => {
  const f = await fixture(t, { failure: 'snapshot:1002' }), result = await f.run()
  assert.equal(result.exit_code, 1); assert.equal(await f.command.selected(f.plan), 'legacy')
  assert.equal((await f.fence.inspect(f.source)).phase, 'restored')
  assert.deepEqual(f.calls, ['prepare-services', 'stop-legacy:1001', 'snapshot:1001', 'snapshot:1002',
    'cancel-preparation:1001', 'cancel-preparation:1002', 'start-legacy:1001'])
  assert.deepEqual(f.registry.read(), []); assert.deepEqual(result.results.map(row => row.state), ['healthy', 'kept_stopped'])
})
test('unknown old shutdown keeps source fenced and never switches, backs up or automatically restores', options, async t => {
  const f = await fixture(t, { failure: 'stop-legacy:1001' }), result = await f.run()
  assert.equal(result.phase, 'interrupted'); assert.equal(await f.command.selected(f.plan), 'legacy')
  assert.equal((await f.fence.inspect(f.source)).phase, 'fenced')
  assert.deepEqual(f.calls, ['prepare-services', 'stop-legacy:1001'])
})
test('uncovered source consumer blocks fencing before any UID action', options, async t => {
  const f = await fixture(t), collect = f.dependencies.processes
  f.dependencies.processes = (...args) => [...collect(...args), { process: { pid: 53000, parent: 1, owner: '1003', started: 'unaccounted', executable: '/usr/bin/node' }, uses_source: true }]
  const result = await f.run()
  assert.equal(result.phase, 'interrupted'); assert.equal(result.error.code, 'CRABOT_LEGACY_SYSTEM_PROCESSES'); assert.deepEqual(f.calls, ['prepare-services'])
  await assert.rejects(fs.lstat(path.join(f.source, '.system-takeover')), { code: 'ENOENT' })
})
test('wrong target root and changed accounts refuse before services or source entries are touched', options, async t => {
  const f = await fixture(t)
  await assert.rejects(systemConversionOperations(f.plan, { ...f.dependencies, root: path.dirname(f.core) }))
  f.registry.accountLookup = () => ({ user: 'other', uid: 2001, gid: 2001, home: '/home/other' })
  await assert.rejects(systemConversionOperations(f.plan, f.dependencies)); assert.deepEqual(f.calls, [])
})

test('actual root metadata recovery observes a lost start reply without reissuing it or dispatching legacy roles', options, async t => {
  const f = await fixture(t, { nested: true }), originalTarget = f.dependencies.target
  f.dependencies.target = async (entry, request) => {
    if (request.action === 'start') throw Error('controlled lost start reply')
    return originalTarget(entry, request)
  }
  const previous = await f.run(); assert.equal(previous.results[0].state, 'unknown')
  const beforeCalls = f.calls.length
  const prepared = await f.store.prepareRecovery(f.plan.id, 'continue', { checkCoordinator: async () => {} })
  assert.equal(f.store.maintenance().operation, 'conversion')
  const recoveryCalls = []
  const recovery = await systemConversionRecoveryOperations(f.plan, { ...f.dependencies, prior: prepared.recovery.base_progress,
    verifyService: () => {}, target: async (entry, request) => {
      assert.equal(request.action, 'inspect'); recoveryCalls.push(entry.uid)
      return { state: 'stopped', generation: null }
    } })
  const result = await f.store.runRecovery(f.plan.id, prepared.recovery.id, recovery)
  assert.equal(result.exit_code, 1)
  assert.deepEqual(result.results.map(row => row.state), ['observed_stopped', 'observed_stopped'])
  assert.equal(result.results[0].original_action_unknown, true)
  assert.deepEqual(f.store.maintenance().unsettled, [])
  assert.deepEqual(f.calls.slice(beforeCalls), ['check-migration:1001', 'check-migration:1002']); assert.deepEqual(recoveryCalls, [1001, 1002])
  for (const { entry } of f.plan.instances) await assert.rejects(fs.lstat(entry.data_dir), { code: 'ENOENT' })
  assert.equal(await f.store.prepareRecovery(f.plan.id, 'continue', { checkCoordinator: async () => {} }), null)
})
for (const changed of ['global-command', 'source-fence', 'target-bytes', 'registry', 'account', 'old-consumer', 'service']) {
  test('post-data recovery rejects changed root facts before any UID operation: ' + changed, options, async t => {
    const f = await fixture(t, { nested: true }); const prior = await f.run(); const calls = []
    const dependencies = { ...f.dependencies, prior, verifyService: () => {}, target: async () => { calls.push('uid'); assert.fail('no UID dispatch') } }
    if (changed === 'global-command') { await fs.unlink(f.command.command); await fs.symlink(path.join(f.source, 'cli.mjs'), f.command.command) }
    if (changed === 'source-fence') await fs.appendFile(path.join(f.source, 'scripts/start.mjs'), '// changed fenced bytes')
    if (changed === 'target-bytes') await fs.appendFile(path.join(f.core, 'package.json'), ' ')
    if (changed === 'registry') await f.registry.update(entries => entries.filter(entry => entry.uid !== 1001))
    if (changed === 'account') f.registry.accountLookup = () => ({ user: 'replacement', uid: 3001, gid: 3001, home: '/home/replacement' })
    if (changed === 'old-consumer') dependencies.processes = () => [{ process: { pid: 91919, parent: 1, owner: '1001', started: 'unexpected', executable: '/usr/bin/node' }, uses_source: true }]
    if (changed === 'service') dependencies.verifyService = () => { throw Error('global service template changed') }
    await assert.rejects(systemConversionRecoveryOperations(f.plan, dependencies)); assert.deepEqual(calls, [])
  })
}

test('real job write failure after last configuration resumes only that unissued startup through the original recovery journal', options, async t => {
  const f = await fixture(t, { nested: true }), [one, two] = f.plan.instances
  const original = one.observation
  two.observation = { ...two.observation, runtime_state: 'running', data_binding: 'observed_running',
    controller: { ...original.controller, pid: 82001, owner: String(two.entry.uid) },
    mm: { ...original.mm, pid: 82002, parent: 82001, owner: String(two.entry.uid) }, mm_port: 19200, launch_kind: 'daemon' }
  one.observation = { ...one.observation, runtime_state: 'stopped', data_binding: 'verified_stopped' }
  for (const field of ['controller', 'mm', 'mm_port', 'launch_kind']) delete one.observation[field]
  let oldAlive = true
  f.dependencies.processes = () => oldAlive ? [two.observation.controller, two.observation.mm].map(process => ({ process, uses_source: true })) : []
  const legacy = f.dependencies.legacy
  f.dependencies.legacy = async (entry, request) => { const value = await legacy(entry, request); if (request.action === 'stop-legacy') oldAlive = false; return value }
  const write = f.store.write.bind(f.store); let faulted = false
  f.store.write = (file, record, mode) => {
    if (!faulted && file.endsWith('/maintenance.json') && record.phase === 'running' && record.current_uid === two.entry.uid
      && record.stage === 'service_configure_dispatched' && f.store.read(f.store.file(f.plan.id), true)?.progress?.results[1].configured) {
      faulted = true; throw Error('controlled last configuration journal boundary')
    }
    return write(file, record, mode)
  }
  await assert.rejects(f.run(), { code: 'CRABOT_SYSTEM_JOURNAL_FAILED' }); assert.equal(faulted, true)
  f.store.write = write
  const prepared = await f.store.prepareRecovery(f.plan.id, 'continue', { checkCoordinator: async () => {} })
  assert.equal(prepared.recovery.base_progress.results[1].start_dispatched, undefined)
  const calls = [], states = new Map(f.plan.instances.map(({ entry }) => [entry.uid, { state: 'stopped', generation: null }]))
  const operations = await systemConversionRecoveryOperations(f.plan, { ...f.dependencies, prior: prepared.recovery.base_progress, verifyService: () => {},
    target: async (entry, request) => {
      assert.equal(request.root, f.core); assert.equal(request.operationId, f.plan.id)
      if (request.action === 'inspect') return states.get(entry.uid)
      assert.equal(request.action, 'start'); assert.equal(entry.uid, two.entry.uid); calls.push(entry.uid)
      assert.deepEqual(request.previous, { state: 'stopped', generation: null })
      const maintenance = f.store.maintenance()
      assert.equal(maintenance.operation, 'conversion'); assert.equal(maintenance.recovery_id, prepared.recovery.id)
      assert.equal(maintenance.stage, 'target_start_dispatched'); assert.deepEqual(maintenance.allow_start, { uid: entry.uid, core_id: f.plan.target.id })
      const generation = 'systemd:new-target'
      states.set(entry.uid, { state: 'running', ready: true, generation, core_id: f.plan.target.id, core_version: f.plan.target.version })
      return { state: 'started', generation }
    } })
  const result = await f.store.runRecovery(f.plan.id, prepared.recovery.id, operations)
  assert.equal(result.exit_code, 0); assert.deepEqual(calls, [two.entry.uid])
  assert.deepEqual(result.results.map(row => row.state), ['observed_stopped', 'healthy'])
  assert.deepEqual(f.store.maintenance().unsettled, []); f.store.assertIdle()
  for (const { entry } of f.plan.instances) await assert.rejects(fs.lstat(entry.data_dir), { code: 'ENOENT' })
})

for (const failure of ['migration', 'service']) test('root-authorized per-user conversion isolates one failure and restores another original runner: ' + failure, options, async t => {
  const f = await fixture(t, { nested: true, ...(failure === 'migration' ? { failure: 'migrate:1001' } : {}) })
  const [one, two] = f.plan.instances, original = one.observation
  two.observation = { ...two.observation, runtime_state: 'running', data_binding: 'observed_running',
    controller: { ...original.controller, pid: 83001, owner: String(two.entry.uid) },
    mm: { ...original.mm, pid: 83002, parent: 83001, owner: String(two.entry.uid) }, mm_port: 19200, launch_kind: 'daemon' }
  const active = new Set([one.entry.uid, two.entry.uid]), legacy = f.dependencies.legacy, target = f.dependencies.target
  f.dependencies.processes = () => f.plan.instances.filter(item => active.has(item.entry.uid))
    .flatMap(item => [item.observation.controller, item.observation.mm].map(process => ({ process, uses_source: true })))
  f.dependencies.legacy = async (entry, request) => {
    const result = await legacy(entry, request)
    if (request.action === 'stop-legacy') active.delete(entry.uid)
    return result
  }
  f.dependencies.target = async (entry, request) => {
    if (failure === 'service' && entry.uid === one.entry.uid && request.action === 'configure-service') throw Error('controlled user service failure')
    return target(entry, request)
  }
  const result = await f.run()
  assert.equal(result.phase, 'completed'); assert.equal(result.exit_code, 1)
  assert.deepEqual(result.results.map(row => row.state), ['unknown', 'healthy'])
  assert.deepEqual(f.store.maintenance().unsettled, [one.entry.uid])
  assert.equal(result.results[0].migrated, failure === 'service' ? true : undefined)
  assert.equal(result.results[1].migrated, true); assert.equal(result.results[1].configured, true)
  assert.equal(f.calls.includes('start:1001'), false); assert.equal(f.calls.includes('start:1002'), true)
  assert.equal(await f.command.selected(f.plan), 'target')
  for (const { entry } of f.plan.instances) await assert.rejects(fs.lstat(entry.data_dir), { code: 'ENOENT' })
})
