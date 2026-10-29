// CI-only actual source GUI/Core plus packaged release. No fake runtime records.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { developmentEnvironment } from '../../scripts/lib/development-environment.mjs'
import { inspectDevelopment, stopDevelopment } from '../../scripts/lib/development.mjs'

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
    let ready = false
    const consume = chunk => { const text = chunk.toString(); output = (output + text).slice(-128_000); if (/"phase":"ready"/.test(output)) ready = true }
    gui.stdout.on('data', consume); gui.stderr.on('data', consume)
    const deadline = Date.now() + 180_000
    while (!ready) {
      if (gui.exitCode !== null || gui.signalCode !== null || Date.now() >= deadline) throw new Error('Source GUI failed to authenticate its actual developer Core\n' + output)
      await new Promise(done => setTimeout(done, 100))
    }
    await sameRelease(baseline.record.generation)
    await stopDevelopment(root)
    assert.equal((await inspectDevelopment(root)).state, 'stopped')
    await sameRelease(baseline.record.generation)
    await start()
    const second = await inspectDevelopment(root)
    assert.equal(second.state, 'running'); assert.notEqual(second.record.generation, first.record.generation)
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
    if (!stopped) await stopDevelopment(root)
  }
}
