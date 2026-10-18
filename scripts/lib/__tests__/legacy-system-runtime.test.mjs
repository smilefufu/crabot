import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import identity from '../process-identity.cjs'
import { discoverLegacySystemDeployment } from '../legacy-system-runtime.mjs'
const options = { skip: process.platform === 'win32' }
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-old-system-runtime-')))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'code'), data = path.join(parent, 'custom-data'), other = path.join(parent, 'other')
  for (const directory of [root, data, other]) fs.mkdirSync(directory)
  fs.mkdirSync(path.join(root, 'crabot-agent')); fs.mkdirSync(path.join(data, 'agent'))
  const context = { release: { installRoot: root }, port_offset_hint: 100 }
  const account = { uid: process.getuid(), user: 'alice', manifest_fingerprint: 'a'.repeat(64), code_fingerprint: 'b'.repeat(64), data_binding: 'unverified' }
  const self = identity.inspectProcess(process.pid)
  const snapshot = { state: 'running', mm_port: 19100, controller: self, mm: self, launch_kind: 'daemon' }
  const agent = { cwd: path.join(root, 'crabot-agent'), env: { DATA_DIR: data, CRABOT_AGENT_DATA_DIR: path.join(data, 'agent'), CRABOT_PORT_OFFSET: '100', api_key: 'must-not-return' } }
  let calls = 0, observations = 0
  const options = { observeAccount: async () => { observations++; return account },
    observeProcesses: async (directory, use) => { assert.equal(directory, root); return use(snapshot, { getDefinition: async name => { assert.equal(name, 'crabot-agent'); calls++; return agent } }) } }
  return { context, root, data, other, snapshot, agent, account, options, calls: () => calls, observations: () => observations,
    discover: overrides => discoverLegacySystemDeployment(context, { ...options, ...overrides }) }
}
test('actual runtime definition establishes the owned custom directory without reading display metadata', options, async t => {
  const f = fixture(t), result = await f.discover()
  assert.equal(result.data_dir, f.data); assert.equal(result.data_binding, 'observed_running'); assert.equal(result.runtime_state, 'running')
  assert.equal(result.mm.pid, process.pid); assert.equal(f.calls(), 1); assert.equal(f.observations(), 2)
  assert.equal(JSON.stringify(result).includes('must-not-return'), false)
})
test('absence of known launchers cannot guess a default data directory or prove a stopped business instance', options, async t => {
  const f = fixture(t); f.snapshot.state = 'stopped'
  const result = await f.discover()
  assert.equal(result.runtime_state, 'no_known_launcher'); assert.equal(result.data_binding, 'unverified')
  assert.equal(result.data_dir, undefined); assert.equal(f.calls(), 0)
})
test('wrong port, module data/cwd/offset and missing directories stay unconverted', options, async t => {
  const f = fixture(t)
  f.snapshot.mm_port++; await assert.rejects(f.discover()); assert.equal(f.calls(), 0); f.snapshot.mm_port--
  for (const [object, key, value] of [[f.agent.env, 'DATA_DIR', './relative'], [f.agent.env, 'DATA_DIR', '/'],
    [f.agent.env, 'CRABOT_AGENT_DATA_DIR', f.other], [f.agent, 'cwd', f.other], [f.agent.env, 'CRABOT_PORT_OFFSET', '200']]) {
    const original = object[key]; object[key] = value
    await assert.rejects(f.discover(), { code: 'CRABOT_LEGACY_SYSTEM_RUNTIME' }); object[key] = original
  }
  fs.rmdirSync(path.join(f.data, 'agent')); await assert.rejects(f.discover())
})
test('code/manifest changes and replaced OS process evidence refuse the discovered binding', options, async t => {
  const f = fixture(t)
  let count = 0
  await assert.rejects(f.discover({ observeAccount: async () => (++count === 1 ? f.account : { ...f.account, manifest_fingerprint: 'c'.repeat(64) }) }))
  f.snapshot.mm = { ...f.snapshot.mm, started: 'different-start' }
  await assert.rejects(f.discover(), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' })
})
