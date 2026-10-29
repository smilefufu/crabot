// CI-only actual source GUI/Core plus packaged release. No fake runtime records.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { developmentEnvironment } from '../../scripts/lib/development-environment.mjs'
import { inspectDevelopment, stopDevelopment } from '../../scripts/lib/development.mjs'

async function captureDevelopmentLogs(root) {
  for (const file of ['supervisor.boot.log', 'mm.stdout.log', 'mm.stderr.log', 'admin-web.log', 'crabot-agent.log', 'memory-default.log', 'vite-dev.log']) {
    try {
      const bytes = await fs.readFile(path.join(root, 'data/logs', file))
      await fs.writeFile(path.join(root, '.desktop-build/development-' + file), bytes.subarray(-128_000))
      console.log('CRABOT_DEVELOPMENT_DIAGNOSTIC ' + JSON.stringify({ file, tail: bytes.subarray(-32_000).toString('utf8') }))
    } catch (error) { if (error.code !== 'ENOENT') console.warn('Source diagnostic unavailable: ' + file) }
  }
}

// Isolate a cold source boot before spending time packaging the release App.
export async function verifyDevelopmentStartup() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Real source boot requires an isolated CI user')
  const root = await fs.realpath(process.env.GITHUB_WORKSPACE), env = developmentEnvironment(root)
  assert.equal((await inspectDevelopment(root)).state, 'stopped')
  try {
    await promisify(execFile)(process.execPath, [path.join(root, 'scripts/dev-background.mjs')], { cwd: root, env, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })
    assert.equal((await inspectDevelopment(root)).state, 'running')
    assert.equal((await fetch('http://127.0.0.1:13000/health', { signal: AbortSignal.timeout(5000) })).ok, true)
    console.log('CRABOT_DEVELOPMENT_SOURCE_BOOT_READY')
  } finally { await captureDevelopmentLogs(root); await stopDevelopment(root) }
}

export async function verifyDevelopmentCoexistence({ inspectRelease, releaseCli }) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Real coexistence requires an isolated CI user')
  const root = await fs.realpath(process.env.GITHUB_WORKSPACE)
  const env = { ...developmentEnvironment(root), CRABOT_DEVELOPMENT_NODE: process.execPath }
  delete env.ELECTRON_RUN_AS_NODE
  const exec = promisify(execFile), diagnostics = path.join(root, '.desktop-build/development-coexistence.log')
  const original = await inspectDevelopment(root)
  assert.equal(original.state, 'stopped', 'Never take over an existing developer instance')
  const baseline = await inspectRelease()
  const start = () => exec(process.execPath, [path.join(root, 'scripts/dev-background.mjs')], { cwd: root, env, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })
  let gui, output = '', stopped = false
  const sameRelease = async generation => {
    const current = await inspectRelease(); assert.equal(current.state, 'running'); assert.equal(current.record.generation, generation)
  }
  try {
    await start()
    const first = await inspectDevelopment(root)
    assert.equal(first.state, 'running'); assert.equal(first.record.mm_port, 29000)
    assert.equal(await fs.realpath(first.record.install_root), root)
    assert.notEqual(first.record.instance_id, baseline.record.instance_id)
    assert.notEqual(first.dataDir, baseline.record.data_dir)
    const electron = createRequire(path.join(root, 'crabot-desktop/package.json'))('electron')
    gui = spawn(electron, [path.join(root, 'crabot-desktop'), '--background'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const readyGenerations = new Set()
    let buffered = '', launchError
    const consume = chunk => {
      const text = chunk.toString(); output = (output + text).slice(-128_000); buffered = (buffered + text).slice(-128_000)
      let end
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
        try { const event = JSON.parse(line); if (event.component === 'desktop' && event.phase === 'ready') readyGenerations.add(event.generation) } catch {}
      }
    }
    gui.stdout.on('data', consume)
    gui.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-128_000) })
    gui.on('error', error => { launchError = error })
    const waitForSourceGui = async generation => {
      const deadline = Date.now() + 180_000
      while (!readyGenerations.has(generation)) {
        if (launchError || gui.exitCode !== null || gui.signalCode !== null || Date.now() >= deadline) throw new Error('Source GUI failed to authenticate its actual developer Core\n' + output)
        await new Promise(done => setTimeout(done, 100))
      }
    }
    await waitForSourceGui(first.record.generation)
    await sameRelease(baseline.record.generation)
    await stopDevelopment(root)
    assert.equal((await inspectDevelopment(root)).state, 'stopped')
    await sameRelease(baseline.record.generation)
    await start()
    const second = await inspectDevelopment(root)
    assert.equal(second.state, 'running'); assert.notEqual(second.record.generation, first.record.generation)
    await waitForSourceGui(second.record.generation)
    await sameRelease(baseline.record.generation)
    await releaseCli('stop')
    assert.equal((await inspectRelease()).state, 'stopped')
    assert.equal((await inspectDevelopment(root)).record.generation, second.record.generation)
    await releaseCli('start', '-d')
    const restarted = await inspectRelease()
    assert.equal(restarted.state, 'running'); assert.notEqual(restarted.record.generation, baseline.record.generation)
    assert.equal((await inspectDevelopment(root)).record.generation, second.record.generation)
    await stopDevelopment(root); stopped = true
    await sameRelease(restarted.record.generation)
    console.log('CRABOT_DEVELOPMENT_COEXISTENCE ' + JSON.stringify({ actual_source_gui_authenticated: true,
      actual_source_and_release_cores: true, independent_data_and_ports: true, stop_and_restart_isolated: true,
      business_agent_tasks_tested: false }))
    return restarted
  } finally {
    if (gui && gui.exitCode === null && gui.signalCode === null) {
      const exited = once(gui, 'exit', { signal: AbortSignal.timeout(30_000) })
      gui.kill('SIGTERM'); await exited
    }
    await fs.writeFile(diagnostics, output)
    await captureDevelopmentLogs(root)
    if (!stopped) await stopDevelopment(root)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], '--source-only')
  await verifyDevelopmentStartup()
}
