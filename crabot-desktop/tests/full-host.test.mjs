import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createServer } from 'node:net'
import controlReader from './full-host-transport.cjs'
import { startFirstModelProvider } from './fixtures/first-model-provider.mjs'
import { randomBytes } from 'node:crypto'
import { inspectInstance } from '../../scripts/lib/instance-runtime.mjs'
import { SUPERVISOR_FORCE_TIMEOUT_MS } from '../../scripts/lib/supervisor-shutdown.mjs'

// A second business MM is forbidden on the developer's live host. CI has its own
// clean user/machine, and every child uses this one disposable DATA_DIR.
test('actual Electron host shares its real core with CLI and distinguishes hide, crash, stop and explicit quit', {
  skip: process.env.GITHUB_ACTIONS !== 'true' || process.env.CRABOT_FULL_CORE_TEST !== '1', timeout: 480_000,
}, async t => {
  const root = fileURLToPath(new URL('../..', import.meta.url)), appRoot = path.join(root, 'crabot-desktop')
  const temporary = await mkdtemp(path.join(tmpdir(), 'Crabot 用户 '))
  const data = path.join(temporary, '实例 数据') // Main creates its private OS ACL/mode.
  const node = path.join(root, process.platform === 'win32' ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const env = { ...process.env, DATA_DIR: data, CRABOT_FULL_HOST_FIXTURE: '1' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CRABOT_DEV; delete env.CRABOT_PORT_OFFSET
  const children = [], controls = []
  t.after(async () => { for (const { server, sockets } of controls) { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } })
  async function waitForExit(child, graceful = false) {
    try {
      // Explicit quit includes the core's complete graceful shutdown window.
      const timeout = graceful ? SUPERVISOR_FORCE_TIMEOUT_MS + 20_000 : 30_000
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit', { signal: AbortSignal.timeout(timeout) })
      return { code: child.exitCode, signal: child.signalCode }
    } finally { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy() }
  }
  const step = phase => console.log('CRABOT_FULL_HOST_STEP ' + JSON.stringify({ platform: process.platform, phase }))
  const cli = async (...args) => (await promisify(execFile)(node, [path.join(root, 'cli.mjs'), ...args], { env, cwd: root, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout
  async function launch() {
    t.signal.throwIfAborted()
    const token = randomBytes(24).toString('hex'), sockets = new Set()
    let connected
    const connection = new Promise(resolve => { connected = resolve })
    const server = createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {})
      controlReader(socket).once('line', supplied => {
        if (supplied !== token) socket.destroy()
        else connected(socket)
      })
    })
    controls.push({ server, sockets })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    t.signal.throwIfAborted()

    const child = spawn(createRequire(import.meta.url)('electron'), [appRoot], { env: { ...env,
      CRABOT_FULL_HOST_CONTROL_PORT: String(server.address().port), CRABOT_FULL_HOST_CONTROL_TOKEN: token,
      NODE_OPTIONS: '--require=' + JSON.stringify(fileURLToPath(new URL('./full-host-preload.cjs', import.meta.url))) }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let output = '', pending = '', ended = false
    const events = []
    // Root process exit is distinct from inherited stdout/stderr pipe closure.
    child.once('exit', () => { ended = true })
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
        t.signal.throwIfAborted()
        const failure = events.find(event => ['fixture_error', 'unexpected_dialog'].includes(event.tag))
        if (failure) throw new Error(JSON.stringify(failure) + '\n' + output)
        const index = events.findIndex(event => event.tag === tag)
        if (index !== -1) return events.splice(index, 1)[0]
        if (ended) throw new Error('Electron exited before ' + tag + '\n' + output)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Timed out waiting for ' + tag + '\n' + output)
    }
    let timer
    const control = await Promise.race([connection, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture control did not connect\n' + output)), 10_000)
    })]).finally(() => clearTimeout(timer))
    const send = value => control.write(value + '\n')
    return { child, exited: graceful => waitForExit(child, graceful), next, send, command: async value => { send(value); return next(value) } }
  }
  const provider = await startFirstModelProvider()
  t.after(() => provider.close())
  try {
    const bootStarted = Date.now()
    let gui = await launch()
    const first = await gui.next('ready')
    const initialReadyMs = Date.now() - bootStarted
    step('initial_ready')
    assert.deepEqual(first.renderer, { node: 'undefined', token: null })
    const instance = inspectInstance(data)
    assert.equal(instance.state, 'running'); assert.equal(instance.record.generation, first.generation)
    assert.notEqual(instance.record.controller.pid, gui.child.pid)
    const firstModelStarted = Date.now()
    gui.send('first_model:' + provider.endpoint)
    const conversation = await gui.next('first_model')
    assert.equal(conversation.visible_reply, true); assert.equal(conversation.durable_delivery, true); assert.equal(conversation.durable_input_ack, true)
    assert.equal(conversation.renderer_token_absent, true); assert.equal(conversation.remote_model_verified, false)
    const modelDeadline = Date.now() + 10_000
    while (!provider.evidence.finished && Date.now() < modelDeadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(provider.evidence.finished, true); assert.equal(provider.evidence.failures, 0)
    assert.equal(provider.evidence.requests, 2)
    assert.equal(inspectInstance(data).record.generation, first.generation)
    console.log('CRABOT_FULL_HOST_FIRST_MODEL ' + JSON.stringify({ ...conversation, requests: provider.evidence.requests, same_generation: true, initial_ready_ms: initialReadyMs, first_model_flow_ms: Date.now() - firstModelStarted }))
    step('first_model_conversation')
    assert.equal((await gui.command('close')).visible, false)
    assert.equal(inspectInstance(data).record.generation, first.generation)
    const status = JSON.parse(await cli('status', '--json'))
    assert.equal(status.running, true)
    assert.equal((await gui.command('show')).visible, true)
    gui.child.kill('SIGKILL'); await gui.exited(); step('gui_crash_exited')
    assert.equal(inspectInstance(data).state, 'running')
    gui = await launch(); assert.equal((await gui.next('ready')).generation, first.generation); step('reattached')
    await cli('stop')
    let stopped
    for (let attempt = 0; attempt < 80; attempt++) {
      stopped = await gui.command('state'); if (stopped.phase === 'stopped') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(stopped.phase, 'stopped')
    assert.equal((await gui.command('show')).phase, 'stopped')
    assert.equal(inspectInstance(data).state, 'stopped')
    step('cli_stopped')
    await cli('start', '-d')
    let joined
    for (let attempt = 0; attempt < 80; attempt++) {
      joined = await gui.command('state'); if (joined.phase === 'ready') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(joined.phase, 'ready')
    assert.notEqual(joined.generation, first.generation)
    assert.equal(inspectInstance(data).record.generation, joined.generation)
    step('cli_started_and_gui_joined')
    await cli('stop')
    for (let attempt = 0; attempt < 80; attempt++) {
      stopped = await gui.command('state'); if (stopped.phase === 'stopped') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(stopped.phase, 'stopped')
    gui.send('quit_confirm'); assert.equal((await gui.exited(true)).code, 0); step('stopped_gui_quit')
    gui = await launch()
    const restarted = await gui.next('ready')
    assert.notEqual(restarted.generation, first.generation)
    assert.equal((await gui.command('quit_cancel')).result, false)
    assert.equal(inspectInstance(data).state, 'running')
    step('active_core_quit_requested')
    gui.send('quit_confirm'); assert.equal((await gui.exited(true)).code, 0)
    assert.equal(inspectInstance(data).state, 'stopped')
    console.log('CRABOT_FULL_HOST_RESULT ' + JSON.stringify({ platform: process.platform, arch: process.arch, native_bootstrap: true,
      cli_gui_same_instance: true, close_keeps_core: true, gui_crash_keeps_core: true, cli_stop_stays_stopped: true, cli_start_reconnects_gui: true, relaunch_autostarts: true, quit_cancel_preserves_core: true, quit_stops_core: true }))
  } catch (error) {
    // Disposable CI data only; preserve the bootstrap cause before cleanup.
    // Never collect credentials, configuration, chats or the developer's data.
    const evidence = path.join(root, '.desktop-build')
    await mkdir(evidence, { recursive: true })
    for (const file of ['supervisor.boot.log', 'mm.stdout.log', 'mm.stderr.log']) {
      const contents = await readFile(path.join(data, 'logs', file)).catch(() => null)
      if (contents) await writeFile(path.join(evidence, 'full-host-' + file), contents.subarray(-128_000))
    }
    throw error
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    const exits = await Promise.allSettled(children.map(child => waitForExit(child)))
    await cli('stop')
    assert.equal(inspectInstance(data).state, 'stopped', 'Preserve fixture data when stop is unverified')
    for (const exit of exits) if (exit.status === 'rejected') throw exit.reason
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
