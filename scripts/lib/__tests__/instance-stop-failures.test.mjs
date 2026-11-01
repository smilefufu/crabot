import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function fixture(t, { rpcFails = false, stale = false, denied = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'crabot-stop-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const controller = { pid: 101, parent: 1, owner: 'fixture', started: '1', executable: '/node' }
  const mm = { ...controller, pid: 102, parent: 101, started: '2' }
  const active = new Map(stale ? [] : [[101, controller], [102, mm]])
  const record = { generation: 'fixture', controller, mm, install_root: root, mm_port: 19000 }
  let cleared = false
  const signals = [], events = []
  const identity = {
    sameProcess: (expected, actual) => !!actual && expected.started === actual.started && expected.pid === actual.pid,
    inspectProcess: pid => pid === process.pid ? { ...controller, pid } : active.get(pid) ?? null,
    listProcessIds: () => [...active.keys()],
    terminateKnownProcess: target => {
      signals.push(target.pid)
      if (denied) throw Object.assign(new Error('Access is denied (Win32 5)'), { code: 'CRABOT_PROCESS_SIGNAL' })
      active.delete(target.pid)
    },
  }
  const adapters = { identity, inspectInstance: () => ({ state: active.size ? 'running' : 'stopped', record }),
    clearInstanceRuntime: () => { cleared = true }, SUPERVISOR_FORCE_TIMEOUT_MS: 70000,
    probeProcessStartIdentity: async () => null, processBirthAtLeast: () => true }
  // Execute the actual controller with a fixture OS and accelerated clock. No real process is signalled.
  globalThis.__crabotStopFixture = adapters
  t.after(() => { delete globalThis.__crabotStopFixture })
  let source = await readFile(new URL('../instance-controller.mjs', import.meta.url), 'utf8')
  source = source.replace(/^import .*from '\.\/.*'$/gm, '')
  source = `const {identity,inspectInstance,clearInstanceRuntime,SUPERVISOR_FORCE_TIMEOUT_MS,probeProcessStartIdentity,processBirthAtLeast}=globalThis.__crabotStopFixture;\n` + source
  source = source.replaceAll("process.platform === 'win32'", 'true')
    .replace('const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))', 'let clock=0; const Date={now:()=>clock}; const sleep=async ms=>{clock+=ms}')
  await writeFile(join(root, 'controller.mjs'), source)
  const { stopInstance, hasRunningModuleProcesses } = await import(pathToFileURL(join(root, 'controller.mjs')).href)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    events.push('rpc')
    if (rpcFails) throw new Error('fixture connection reset')
    active.clear()
    return { ok: true, json: async () => ({ success: true }) }
  }
  t.after(() => { globalThis.fetch = originalFetch })
  await mkdir(join(root, 'module-runtime-registry/records'), { recursive: true })
  await writeFile(join(root, 'module-runtime-registry/instance-id'), 'fixture')
  await writeFile(join(root, 'module-runtime-registry/records/stale.json'), JSON.stringify({ instance_id: 'fixture', root_pid: 103, process_start_identity: 'old' }))
  return { observe: () => hasRunningModuleProcesses(root), stop: () => stopInstance(root), signals, events, cleared: () => cleared, active, root }
}

test('Windows RPC failure still reaches exact-generation termination and completes stop', async t => {
  const f = await fixture(t, { rpcFails: true })
  await f.stop()
  assert.deepEqual(f.events, ['rpc'])
  assert.deepEqual(f.signals, [102, 101])
  assert.equal(f.active.size, 0)
  assert.equal(f.cleared(), true)
})

test('already-exited processes stop successfully despite retained module records', async t => {
  const f = await fixture(t, { stale: true })
  await f.stop()
  assert.deepEqual(f.signals, [])
  assert.deepEqual(f.events, [])
  assert.equal(f.cleared(), true)
  assert.match(await readFile(join(f.root, 'module-runtime-registry/records/stale.json'), 'utf8'), /process_start_identity/)
})

test('a real termination denial identifies the exact PID and OS reason, preserving runtime evidence', async t => {
  const f = await fixture(t, { rpcFails: true, denied: true })
  await assert.rejects(f.stop(), error => {
    assert.equal(error.code, 'CRABOT_STOP_INCOMPLETE')
    assert.match(error.message, /102/)
    assert.match(error.message, /Win32 5/)
    return true
  })
  assert.equal(f.cleared(), false)
})


test('departed module recovery files do not become live activity during an offline update', async t => {
  const f = await fixture(t, { stale: true })
  assert.equal(await f.observe(), false)
})
