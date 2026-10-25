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
import { systemConversionOperations } from '../system-conversion-job.mjs'
import { LegacySystemEntryFence } from '../legacy-system-fence.mjs'
import { LegacySystemCommandLink } from '../legacy-system-command.mjs'
import { discoverLegacySystemRelease } from '../legacy-system-release.mjs'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
const options = { skip: process.platform === 'win32' }
async function fixture(t, { failure } = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-conversion-wiring-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const source = path.join(parent, 'old'), install = path.join(parent, 'managed'), staging = path.join(install, 'staging')
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
    processes: () => running ? [instances[0].observation.controller, instances[0].observation.mm].map(process => ({ process, uses_source: true })) : [],
    legacy: async (entry, request) => {
      const action = request.action, phase = (await fence.inspect(source)).phase
      const bootId = randomUUID(), record = structuredClone(store.read(store.file(plan.id), true)), maintenance = structuredClone(store.maintenance())
      record.boot_id = bootId; maintenance.boot_id = bootId
      const permit = createLegacySystemConversionPermit({ record, maintenance, entry, bootId, action, sourceFence: await fence.inspect(source) })
      assert.equal(permit.action, action)
      assert.equal(phase, action === 'start-legacy' ? 'restored' : action === 'migrate' ? 'data_changing' : 'fenced')
      assert.deepEqual(request, { root: core, operationId: plan.id, action })
      calls.push(action + ':' + entry.uid)
      if (failure === action + ':' + entry.uid) throw new Error('controlled role failure')
      if (action === 'stop-legacy') { running = false; return { state: 'stopped', request_acknowledged: true } }
      if (action === 'snapshot') return { id: randomUUID(), system_operation_id: plan.id, target_id: plan.target.id, backup: { id: randomUUID(), sha256: 'd'.repeat(64) } }
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
  const f = await fixture(t)
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
  f.dependencies.processes = () => [...collect(), { process: { pid: 53000, parent: 1, owner: '1003', started: 'unaccounted', executable: '/usr/bin/node' }, uses_source: true }]
  const result = await f.run()
  assert.equal(result.phase, 'interrupted'); assert.deepEqual(f.calls, ['prepare-services'])
  await assert.rejects(fs.lstat(path.join(f.source, '.system-takeover')), { code: 'ENOENT' })
})
test('wrong target root and changed accounts refuse before services or source entries are touched', options, async t => {
  const f = await fixture(t)
  await assert.rejects(systemConversionOperations(f.plan, { ...f.dependencies, root: path.dirname(f.core) }))
  f.registry.accountLookup = () => ({ user: 'other', uid: 2001, gid: 2001, home: '/home/other' })
  await assert.rejects(systemConversionOperations(f.plan, f.dependencies)); assert.deepEqual(f.calls, [])
})
