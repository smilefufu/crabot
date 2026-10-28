import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import identity from '../process-identity.cjs'
import { newCredentialsFromPassword } from '../../../crabot-admin/dist/credentials.js'
const options = { skip: process.platform === 'win32' }
async function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-legacy-restore-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const actual = userInfo(), root = path.join(directory, 'old-code'), data = path.join(directory, 'data')
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'crabot-agent')); fs.mkdirSync(data, { mode: 0o700 })
  for (const name of ['admin', 'agent', 'memory']) fs.mkdirSync(path.join(data, name), { mode: 0o700 })
  const credentials = JSON.stringify(await newCredentialsFromPassword('keep-existing-secret', { is_temp: false, changed_via: 'start' }))
  fs.writeFileSync(path.join(data, 'admin/credentials.json'), credentials, { mode: 0o600 })
  const entry = { user: actual.username, uid: actual.uid, gid: actual.gid, home: actual.homedir,
    data_dir: data, port_offset: 100, enabled: true, autostart: false }
  const source = { installRoot: root, version: 'v2026.10.15.1', code_fingerprint: 'a'.repeat(64) }
  const stat = fs.statSync(data, { bigint: true }), node = fs.realpathSync(process.execPath)
  const expected = { user: entry.user, uid: entry.uid, port_offset: 100, install_root: root, code_fingerprint: source.code_fingerprint,
    manifest_fingerprint: 'b'.repeat(64), data_dir: data, data_directory: { device: String(stat.dev), inode: String(stat.ino) },
    runtime_state: 'running', data_binding: 'observed_running',
    controller: { pid: 910001, parent: 1, owner: String(entry.uid), started: 'original-controller', executable: node },
    mm: { pid: 910002, parent: 910001, owner: String(entry.uid), started: 'original-mm', executable: node }, mm_port: 19100, launch_kind: 'daemon' }
  const calls = [], account = { user: entry.user, uid: entry.uid, port_offset: 100, install_root: root,
    code_fingerprint: source.code_fingerprint, manifest_fingerprint: expected.manifest_fingerprint, data_binding: 'unverified' }
  let launched = false
  const current = { state: 'running', controller: { ...expected.controller, pid: 920001, started: 'restored-controller' },
    mm: { ...expected.mm, pid: 920002, parent: 920001, started: 'restored-mm' }, mm_port: 19100, launch_kind: 'daemon' }
  const definition = { cwd: path.join(root, 'crabot-agent'), env: { DATA_DIR: data, CRABOT_AGENT_DATA_DIR: path.join(data, 'agent'), CRABOT_PORT_OFFSET: '100' } }
  const parameters = { expected, operationId: randomUUID(), waitMs: 25,
    runtimeOptions: { observeAccount: async () => account, observeProcesses: async (_, use) => use(launched ? structuredClone(current) : { state: 'stopped' }, { getDefinition: async () => definition }) },
    run: async (command, args, settings) => { calls.push({ command, args, settings }); launched = true; return { stdout: '' } },
    readiness: async () => ({ ready: true, health: 'degraded' }),
  }
  const inspect = identity.inspectProcess
  t.mock.method(identity, 'inspectProcess', pid => pid === current.controller.pid ? current.controller : pid === current.mm.pid ? current.mm : inspect(pid))
  const context = { account: { user: entry.user, uid: entry.uid, gid: entry.gid, home: entry.home }, release: source, port_offset_hint: 100 }
  const invoke = async extra => {
    const { startRestoredLegacySystemInstance } = await import(pathToFileURL(path.resolve('scripts/lib/legacy-system-start.mjs')))
    return startRestoredLegacySystemInstance(entry, context, { ...parameters, ...extra })
  }
  return { directory, root, data, entry, expected, context, parameters, current, definition, account, calls, credentials, invoke }
}
test('pre-data restoration invokes the original Node and normal old start in an independent user service, preserving credentials', options, async t => {
  const f = await fixture(t), result = await f.invoke()
  assert.equal(result.state, 'started'); assert.equal(f.calls.length, 1)
  const { command, args, settings } = f.calls[0]
  assert.equal(command, '/usr/bin/systemd-run'); assert.ok(args.includes('--user')); assert.ok(args.includes('--property=Type=forking'))
  assert.ok(args.includes('--property=PIDFile=' + f.data + '/mm.pid'))
  assert.deepEqual(args.slice(-4), ['--', f.expected.controller.executable, f.root + '/scripts/start.mjs', '-d'])
  assert.ok(args.includes('--expand-environment=no')); assert.equal(settings.env.HOME, f.entry.home)
  assert.equal(settings.env.DATA_DIR, f.data); assert.equal(settings.env.NODE_OPTIONS, undefined)
  assert.equal(args.some(value => /supervisor\.mjs|crabot\.service|--remain-after-exit/.test(value)), false)
  assert.equal(fs.readFileSync(f.data + '/admin/credentials.json', 'utf8'), f.credentials)
})
for (const changed of ['other-uid', 'originally-stopped', 'directory-replaced', 'manifest-changed', 'remaining-process', 'pending-data', 'node-missing', 'invalid-operation']) {
  test('restoration refuses before launch instead of falling back or starting a different instance: ' + changed, options, async t => {
    const f = await fixture(t)
    if (changed === 'other-uid') f.entry.uid++
    if (changed === 'originally-stopped') { f.expected.runtime_state = 'stopped'; f.expected.data_binding = 'verified_stopped' }
    if (changed === 'directory-replaced') { fs.renameSync(f.data, f.data + '-retained'); fs.mkdirSync(f.data, { mode: 0o700 }) }
    if (changed === 'manifest-changed') f.account.manifest_fingerprint = 'c'.repeat(64)
    if (changed === 'remaining-process') fs.writeFileSync(f.data + '/mm.pid', String(process.pid))
    if (changed === 'pending-data') fs.writeFileSync(f.data + '/desktop-maintenance.json', '{}', { mode: 0o600 })
    if (changed === 'node-missing') f.expected.controller.executable = f.expected.mm.executable = f.directory + '/missing-node'
    if (changed === 'invalid-operation') f.parameters.operationId = '../arbitrary'
    await assert.rejects(f.invoke()); assert.equal(f.calls.length, 0)
  })
}
for (const changed of ['wrong-directory', 'wrong-node', 'unhealthy', 'old-generation', 'invoke-failed', 'data-replaced-during-health', 'maintenance-during-health', 'generation-during-health']) {
  test('a launched service is not reported restored without exact old binding and new healthy process evidence: ' + changed, options, async t => {
    const f = await fixture(t)
    if (changed === 'wrong-directory') f.definition.env.DATA_DIR = f.directory
    if (changed === 'wrong-node') f.current.controller.executable = f.current.mm.executable = '/other/node'
    if (changed === 'unhealthy') f.parameters.readiness = async () => ({ ready: false, health: 'unhealthy' })
    if (changed === 'old-generation') { f.current.controller = f.expected.controller; f.current.mm = f.expected.mm }
    if (changed === 'data-replaced-during-health') f.parameters.readiness = async () => {
      fs.renameSync(f.data, f.data + '-retained'); fs.mkdirSync(f.data, { mode: 0o700 }); return { ready: true, health: 'healthy' }
    }
    if (changed === 'maintenance-during-health') f.parameters.readiness = async () => {
      fs.writeFileSync(f.data + '/desktop-maintenance.json', '{}', { mode: 0o600 }); return { ready: true, health: 'healthy' }
    }
    if (changed === 'generation-during-health') f.parameters.readiness = async () => {
      f.current.mm.started = 'replacement'; return { ready: true, health: 'healthy' }
    }
    if (changed === 'invoke-failed') f.parameters.run = async () => { f.calls.push('failed'); throw new Error('unknown start outcome') }
    await assert.rejects(f.invoke()); assert.equal(f.calls.length, 1)
  })
}
