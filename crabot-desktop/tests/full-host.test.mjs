import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inspectInstance } from '../../scripts/lib/instance-runtime.mjs'

// A second business MM is forbidden on the developer's live host. CI has its own
// clean user/machine, and every child uses this one disposable DATA_DIR.
test('actual Electron host shares its real core with CLI and distinguishes hide, crash, stop and explicit quit', {
  skip: process.env.GITHUB_ACTIONS !== 'true' || process.env.CRABOT_FULL_CORE_TEST !== '1', timeout: 480_000,
}, async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url)), appRoot = path.join(root, 'crabot-desktop')
  const temporary = await mkdtemp(path.join(tmpdir(), 'Crabot 用户 '))
  const data = path.join(temporary, '实例 数据') // Main creates its private OS ACL/mode.
  const node = path.join(root, process.platform === 'win32' ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const env = { ...process.env, DATA_DIR: data, CRABOT_FULL_HOST_FIXTURE: '1' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CRABOT_DEV; delete env.CRABOT_PORT_OFFSET
  const children = []
  const cli = async (...args) => (await promisify(execFile)(node, [path.join(root, 'cli.mjs'), ...args], { env, cwd: root, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout
  function launch() {
    const child = spawn(createRequire(import.meta.url)('electron'), [appRoot], { env: { ...env,
      NODE_OPTIONS: '--require=' + JSON.stringify(fileURLToPath(new URL('./full-host-preload.cjs', import.meta.url))) }, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let output = '', pending = '', ended = false
    const events = []
    const exited = new Promise(resolve => child.once('close', (code, signal) => { ended = true; resolve({ code, signal }) }))
    child.stdout.on('data', bytes => {
      const text = bytes.toString(); output = (output + text).slice(-128_000); pending += text
      let end
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        if (!line.startsWith('CRABOT_FULL_HOST ')) continue
        events.push(JSON.parse(line.slice('CRABOT_FULL_HOST '.length)))
      }
    })
    child.stderr.on('data', bytes => { output = (output + bytes).slice(-128_000) })
    child.on('error', error => { events.push({ tag: 'fixture_error', message: String(error) }) })
    async function next(tag) {
      const deadline = Date.now() + 100_000
      while (Date.now() < deadline) {
        const failure = events.find(event => ['fixture_error', 'unexpected_dialog'].includes(event.tag))
        if (failure) throw new Error(JSON.stringify(failure) + '\n' + output)
        const index = events.findIndex(event => event.tag === tag)
        if (index !== -1) return events.splice(index, 1)[0]
        if (ended) throw new Error('Electron exited before ' + tag + '\n' + output)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Timed out waiting for ' + tag + '\n' + output)
    }
    return { child, exited, next, command: async value => { child.stdin.write(value + '\n'); return next(value) } }
  }
  try {
    let gui = launch()
    const first = await gui.next('ready')
    assert.deepEqual(first.renderer, { node: 'undefined', token: null })
    const instance = inspectInstance(data)
    assert.equal(instance.state, 'running'); assert.equal(instance.record.generation, first.generation)
    assert.notEqual(instance.record.controller.pid, gui.child.pid)
    assert.equal((await gui.command('close')).visible, false)
    assert.equal(inspectInstance(data).record.generation, first.generation)
    const status = JSON.parse(await cli('status', '--json'))
    assert.equal(status.running, true)
    assert.equal((await gui.command('show')).visible, true)
    gui.child.kill('SIGKILL'); await gui.exited
    assert.equal(inspectInstance(data).state, 'running')
    gui = launch(); assert.equal((await gui.next('ready')).generation, first.generation)
    await cli('stop')
    let stopped
    for (let attempt = 0; attempt < 80; attempt++) {
      stopped = await gui.command('state'); if (stopped.phase === 'stopped') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(stopped.phase, 'stopped')
    assert.equal((await gui.command('show')).phase, 'stopped')
    assert.equal(inspectInstance(data).state, 'stopped')
    await cli('start', '-d')
    let joined
    for (let attempt = 0; attempt < 80; attempt++) {
      joined = await gui.command('state'); if (joined.phase === 'ready') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(joined.phase, 'ready')
    assert.notEqual(joined.generation, first.generation)
    assert.equal(inspectInstance(data).record.generation, joined.generation)
    await cli('stop')
    for (let attempt = 0; attempt < 80; attempt++) {
      stopped = await gui.command('state'); if (stopped.phase === 'stopped') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(stopped.phase, 'stopped')
    gui.child.stdin.write('quit_confirm\n'); assert.equal((await gui.exited).code, 0)
    gui = launch()
    const restarted = await gui.next('ready')
    assert.notEqual(restarted.generation, first.generation)
    assert.equal((await gui.command('quit_cancel')).result, false)
    assert.equal(inspectInstance(data).state, 'running')
    gui.child.stdin.write('quit_confirm\n'); assert.equal((await gui.exited).code, 0)
    assert.equal(inspectInstance(data).state, 'stopped')
    console.log('CRABOT_FULL_HOST_RESULT ' + JSON.stringify({ platform: process.platform, arch: process.arch, native_bootstrap: true,
      cli_gui_same_instance: true, close_keeps_core: true, gui_crash_keeps_core: true, cli_stop_stays_stopped: true, cli_start_reconnects_gui: true, relaunch_autostarts: true, quit_cancel_preserves_core: true, quit_stops_core: true }))
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await cli('stop')
    assert.equal(inspectInstance(data).state, 'stopped', 'Preserve fixture data when stop is unverified')
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
