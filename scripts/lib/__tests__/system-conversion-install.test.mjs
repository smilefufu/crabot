import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { SystemRegistry } from '../system-registry.mjs'
import { SystemOperationStore } from '../system-operation.mjs'
import { LegacySystemEntryFence } from '../legacy-system-fence.mjs'
import { randomUUID } from 'node:crypto'
import { LegacySystemCommandLink } from '../legacy-system-command.mjs'
import { discoverLegacySystemRelease } from '../legacy-system-release.mjs'
import { readLegacySystemHints, resolveLegacySystemCandidates } from '../legacy-system-hints.mjs'
import { preflightLegacySystemConversion } from '../system-conversion-preflight.mjs'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { installSystemCore } from '../system-conversion-install.mjs'
const options = { skip: process.platform === 'win32' }
async function fixture(t, { running = false } = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-conversion-install-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const old = path.join(parent, 'old'), sourceRoot = path.join(parent, 'new'), global = path.join(parent, 'bin/crabot'), hintsFile = path.join(parent, 'ports.json')
  for (const directory of [old, sourceRoot, path.dirname(global)]) await fs.mkdir(directory)
  await materializeLegacyRelease(old)
  await fs.symlink(path.join(old, 'cli.mjs'), global)
  for (const name of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(sourceRoot, name), '{"version":"1.2.4"}')
  await writeCoreRelease(sourceRoot, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: 'a'.repeat(40), source_dirty: false })
  const release = await verifyCoreRelease(sourceRoot), calls = [], messages = [], accounts = [1001, 1002].map(uid => ({ user: 'employee' + uid, uid, gid: uid, home: '/home/employee' + uid }))
  await fs.writeFile(hintsFile, JSON.stringify(accounts.map((account, index) => ({ user: account.user, offset: (index + 1) * 100 }))))
  const registry = new SystemRegistry({ directory: path.join(parent, 'system'), ownerUid: process.getuid(), accountLookup: user => accounts.find(value => value.user === user) })
  const store = new SystemOperationStore(registry), command = new LegacySystemCommandLink({ command: global, directory: registry.directory, ownerUid: process.getuid(), checkRoot: () => {} })
  const discoverRelease = value => discoverLegacySystemRelease({ ...value, platform: 'linux', ownerUid: process.getuid(), checkRoot: () => {} })
  const readHints = () => readLegacySystemHints({ file: hintsFile, ownerUid: process.getuid() })
  let submitted
  const args = { sourceRoot, installRoot: old, registry, command, store, log: text => messages.push(text),
    fence: new LegacySystemEntryFence({ ownerUid: process.getuid(), checkRoot: () => {} }), checkRoot: () => {}, available: () => true, discoverRelease, readHints, confirm: async () => { calls.push('confirm'); return true },
    install: async ({ installRoot, scope, sourceRoot: source }) => {
      calls.push('install'); assert.equal(scope, 'system'); assert.equal(source, sourceRoot)
      const coreRoot = path.join(installRoot, 'releases', release.inventory_sha256), launcher = 'fixed never-executed test launcher'
      await fs.mkdir(path.join(installRoot, 'releases'), { recursive: true }); await fs.mkdir(path.join(installRoot, 'bin'), { recursive: true })
      await fs.cp(sourceRoot, coreRoot, { recursive: true })
      await fs.writeFile(path.join(installRoot, 'current-core'), release.inventory_sha256 + '\n')
      await fs.writeFile(path.join(installRoot, 'cli-installation.json'), JSON.stringify({ schema_version: 1, scope: 'system', launcher_sha256: createHash('sha256').update(launcher).digest('hex') }))
      await fs.writeFile(path.join(installRoot, 'bin/crabot'), launcher, { mode: 0o755 })
      return { installRoot, coreRoot, id: release.inventory_sha256, version: release.version, command: path.join(installRoot, 'bin/crabot') }
    },
    preflight: async value => {
      calls.push('preflight')
      return preflightLegacySystemConversion({ ...value, discoverRelease, readHints, checkRoot: () => {},
        resolveCandidates: snapshot => resolveLegacySystemCandidates(snapshot, { lookup: user => accounts.find(value => value.user === user) }),
        observe: async (account, { release: oldRelease, portOffsetHint }) => ({ user: account.user, uid: account.uid, port_offset: portOffsetHint,
          install_root: old, code_fingerprint: oldRelease.code_fingerprint, manifest_fingerprint: 'b'.repeat(64),
          data_dir: path.join(parent, 'private-data-' + account.uid), data_directory: { device: '1', inode: String(account.uid) },
          runtime_state: running && account.uid === accounts[0].uid ? 'running' : 'stopped',
          data_binding: running && account.uid === accounts[0].uid ? 'observed_running' : 'verified_stopped',
          ...(running && account.uid === accounts[0].uid ? {
            controller: { pid: 81001, parent: 1, owner: String(account.uid), started: 'old-controller', executable: '/usr/bin/node' },
            mm: { pid: 81002, parent: 81001, owner: String(account.uid), started: 'old-mm', executable: '/usr/bin/node' },
            mm_port: 19000 + portOffsetHint, launch_kind: 'daemon',
          } : {}) }) })
    },
    submit: async (plan, value) => {
      calls.push('submit'); submitted = plan
      assert.equal(value.root, path.join(plan.install_root, 'releases', release.inventory_sha256)); assert.equal(value.store, store)
      await value.store.prepare(plan); return 0
    },
  }
  return { parent, old, sourceRoot, global, hintsFile, accounts, registry, store, command, calls, messages, args, release,
    invoke: extra => installSystemCore({ ...args, ...extra }), submitted: () => submitted }
}
for (const separate of [false, true]) test('installer prepares the original conversion with one confirmation and no employee data I/O: ' + separate, options, async t => {
  const f = await fixture(t), installRoot = separate ? path.join(f.parent, 'chosen') : f.old
  const original = await fs.readFile(path.join(f.old, 'cli.mjs')), result = await f.invoke({ installRoot })
  assert.equal(result.installRoot, separate ? installRoot : path.join(f.old, '.managed'))
  assert.equal(result.converted, true)
  assert.deepEqual(f.calls, ['install', 'preflight', 'confirm', 'submit'])
  assert.equal(f.store.maintenance().phase, 'prepared'); assert.equal(f.submitted().kind, 'conversion')
  assert.deepEqual(f.registry.read(), [])
  assert.deepEqual(await fs.readFile(path.join(f.old, 'cli.mjs')), original)
  assert.equal(await fs.readlink(f.global), path.join(f.old, 'cli.mjs'), 'the wrapper cannot switch the global command')
  for (const { entry } of f.submitted().instances) await assert.rejects(fs.lstat(entry.data_dir), { code: 'ENOENT' })
  assert.match(f.messages.join('\n'), /employee1001.*保持停止/)
  assert.match(f.messages.join('\n'), /system status/)
})
for (const mode of ['cancel', 'hints-change', 'systemd-missing', 'modified-old-code', 'foreign-managed', 'conflicting-command', 'preflight-rejected', 'submit-failed']) {
  test('installer preserves original service/code on failure without replay or an empty employee instance: ' + mode, options, async t => {
    const f = await fixture(t), extra = {}
    if (mode === 'cancel') extra.confirm = async () => false
    if (mode === 'hints-change') extra.confirm = async () => { await fs.appendFile(f.hintsFile, ' '); return true }
    if (mode === 'systemd-missing') extra.available = () => false
    if (mode === 'modified-old-code') await fs.appendFile(path.join(f.old, 'cli.mjs'), '// keep local modification')
    if (mode === 'foreign-managed') { await fs.mkdir(path.join(f.old, '.managed')); await fs.writeFile(path.join(f.old, '.managed/foreign'), 'keep') }
    if (mode === 'conflicting-command') { await fs.unlink(f.global); await fs.symlink(path.join(f.parent, 'other/cli.mjs'), f.global) }
    if (mode === 'preflight-rejected') extra.preflight = async () => { throw Error('controlled binding rejection') }
    if (mode === 'submit-failed') extra.submit = async (plan, { store }) => { await store.prepare(plan); throw Error('controlled systemd submit failure') }
    const original = await fs.readFile(path.join(f.old, 'cli.mjs')), global = await fs.readlink(f.global)
    await assert.rejects(f.invoke(extra))
    assert.deepEqual(await fs.readFile(path.join(f.old, 'cli.mjs')), original)
    assert.equal(await fs.readlink(f.global), global)
    assert.equal(f.calls.includes('submit'), false)
    if (mode === 'submit-failed') assert.equal(f.store.maintenance().phase, 'prepared')
    else await assert.rejects(fs.lstat(f.registry.directory), { code: 'ENOENT' })
    for (const account of f.accounts) await assert.rejects(fs.lstat(path.join(f.parent, 'private-data-' + account.uid)), { code: 'ENOENT' })
    if (['systemd-missing', 'modified-old-code', 'foreign-managed', 'conflicting-command'].includes(mode)) assert.equal(f.calls.length, 0)
    if (mode === 'foreign-managed') assert.equal(await fs.readFile(path.join(f.old, '.managed/foreign'), 'utf8'), 'keep')
  })
}
test('a fresh system installation keeps the standalone install path without conversion prompts or registry I/O', options, async t => {
  const f = await fixture(t); await fs.unlink(f.global)
  const installRoot = path.join(f.parent, 'fresh'), result = await f.invoke({ installRoot })
  assert.equal(result.installRoot, installRoot); assert.equal(result.converted, undefined)
  assert.deepEqual(f.calls, ['install']); await assert.rejects(fs.lstat(f.registry.directory), { code: 'ENOENT' })
})

test('a noninteractive conversion cannot silently accept maintenance', options, async t => {
  if (process.stdin.isTTY) return t.skip('requires piped stdin')
  const f = await fixture(t)
  await assert.rejects(f.invoke({ confirm: undefined }), /交互终端/)
  await assert.rejects(fs.lstat(f.registry.directory), { code: 'ENOENT' })
})
for (const incomplete of [false, true, 'migration', 'unsettled']) test('rerunning the original installer uses only an independently completed conversion: ' + incomplete, options, async t => {
  const f = await fixture(t); await f.invoke()
  const plan = f.submitted(), fence = f.args.fence
  const result = await f.store.run(plan.id, { conversion: {
    fence: () => fence.fence(plan.source, plan.id),
    snapshot: async () => ({ id: randomUUID(), system_operation_id: plan.id, target_id: plan.target.id, backup: { id: randomUUID(), sha256: 'c'.repeat(64) } }),
    selectTarget: () => f.command.select(plan),
    sealSource: (id, operation) => fence.seal(f.old, id, operation),
    migrate: async () => ({ migrated: true, service_started: false }),
    register: entry => f.registry.registerConverted(entry, { operationId: plan.id }),
    configure: async () => {}, observeTarget: async () => ({ state: 'stopped' }),
  } })
  assert.equal(result.exit_code, 0)
  if (incomplete) {
    const file = f.store.file(plan.id), job = f.store.read(file, true)
    if (incomplete === 'migration') job.progress.results[0].migrated = false
    else if (incomplete === 'unsettled') job.progress.results[0].state = 'pending'
    else job.phase = 'interrupted'
    f.store.write(file, job, 0o600)
    await assert.rejects(f.invoke())
  } else {
    const repeated = await f.invoke()
    assert.equal(repeated.installRoot, plan.install_root)
    assert.equal(f.calls.filter(call => call === 'confirm').length, 1)
  }
  assert.equal(await fs.readlink(f.global), path.join(plan.install_root, 'bin/crabot'))
  for (const { entry } of plan.instances) await assert.rejects(fs.lstat(entry.data_dir), { code: 'ENOENT' })
})

test('a restored pre-data failure can be previewed and confirmed again without deleting old protection', options, async t => {
  const f = await fixture(t); await f.invoke()
  const plan = f.submitted(), fence = f.args.fence
  const result = await f.store.run(plan.id, { conversion: {
    fence: () => fence.fence(plan.source, plan.id), snapshot: async () => { throw Error('controlled backup failure') },
    selected: () => f.command.selected(plan), cancelSnapshot: async () => {},
    restoreSource: (id, operation) => fence.restore(f.old, id, operation),
  } })
  assert.equal(result.exit_code, 1); assert.equal(result.phase, 'completed')
  assert.equal((await fence.inspect(f.old)).phase, 'restored')
  const retried = await f.invoke()
  assert.equal(retried.installRoot, plan.install_root)
  assert.equal(f.calls.filter(call => call === 'confirm').length, 2)
  assert.notEqual(f.submitted().id, plan.id)
  assert.equal(await f.command.selected(plan), 'legacy')
})

for (const answer of ['y', 'n']) test('piped installer asks once on its controlling terminal: ' + answer, options, () => {
  const code = "import {confirmSystemConversion} from " + JSON.stringify(new URL('../system-conversion-install.mjs', import.meta.url).href) + ";console.log('CONFIRM_RESULT='+await confirmSystemConversion())"
  const probe = spawnSync('/usr/bin/python3', ['-c', String.raw`
import os,pty,select,signal,sys,time
pid,master=pty.fork()
if pid==0:
    read,write=os.pipe();os.close(write);os.dup2(read,0);os.close(read)
    os.execv(sys.argv[1],[sys.argv[1],'--input-type=module','-e',sys.argv[2]])
output=b'';answered=False;status=None;deadline=time.monotonic()+10
try:
    while time.monotonic()<deadline:
        if select.select([master],[],[],0.1)[0]:
            try: chunk=os.read(master,8192)
            except OSError: chunk=b''
            output+=chunk
        if b'[y/N]' in output and not answered:
            os.write(master,sys.argv[3].encode()+b'\n');answered=True
        done,value=os.waitpid(pid,os.WNOHANG)
        if done: status=value;break
finally:
    if status is None: os.kill(pid,signal.SIGTERM);os.waitpid(pid,0)
    os.close(master)
sys.stdout.write(output.decode('utf-8','replace'))
if status is None or os.waitstatus_to_exitcode(status)!=0: sys.exit(1)
`, process.execPath, code, answer], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 })
  assert.equal(probe.status, 0, probe.stdout + probe.stderr)
  assert.match(probe.stdout, new RegExp('CONFIRM_RESULT=' + (answer === 'y')))
  assert.equal(probe.stdout.split('[y/N]').length, 2)
})

test('a safely observed conversion recovery permits repeating the original installer despite its historical nonzero action result', options, async t => {
  const f = await fixture(t, { running: true }); await f.invoke()
  const plan = f.submitted(), fence = f.args.fence
  const original = await f.store.run(plan.id, { conversion: {
    fence: () => fence.fence(plan.source, plan.id), stop: async () => ({ state: 'stopped', request_acknowledged: true }),
    snapshot: async () => ({ id: randomUUID(), system_operation_id: plan.id, target_id: plan.target.id, backup: { id: randomUUID(), sha256: 'c'.repeat(64) } }),
    selectTarget: () => f.command.select(plan), sealSource: (id, operation) => fence.seal(f.old, id, operation),
    migrate: async () => ({ migrated: true, service_started: false }), register: entry => f.registry.registerConverted(entry, { operationId: plan.id }),
    configure: async () => {}, observeTarget: async () => ({ state: 'stopped' }), startTarget: async () => { throw Error('controlled lost startup reply') },
  } })
  assert.equal(original.exit_code, 1); assert.equal(original.results[0].state, 'unknown')
  const prepared = await f.store.prepareRecovery(plan.id, 'continue', { checkCoordinator: async () => {} })
  const restored = await f.store.runRecovery(plan.id, prepared.recovery.id, {
    verify: async () => assert.equal(await f.command.selected(plan), 'target'),
    verifyTargetData: async () => ({ verified: true, service_started: false }),
    observeTarget: async entry => entry.uid === plan.instances[0].entry.uid
      ? { state: 'running', ready: true, core_id: plan.target.id, core_version: plan.target.version, generation: 'observed-target' }
      : { state: 'stopped', generation: null },
    startTarget: () => assert.fail('issued startup must not repeat'),
  })
  assert.equal(restored.exit_code, 1); assert.equal(restored.results[0].original_action_unknown, true)
  assert.equal(restored.phase, 'completed'); assert.deepEqual(f.store.maintenance().unsettled, [])
  const repeat = await f.invoke(); assert.equal(repeat.installRoot, plan.install_root)
  assert.equal(f.store.maintenance().id, plan.id); assert.equal(f.calls.filter(call => call === 'confirm').length, 1)
})
