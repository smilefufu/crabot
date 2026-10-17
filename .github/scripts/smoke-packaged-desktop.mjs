// Actual packaged executable/ASAR/fuses and native bootstrap, no injected hooks.
// CI-only: the developer's live user may already own the single business MM.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Packaged core boot test requires an isolated CI user')
const project = await fs.realpath(path.resolve(process.argv[2]))
const location = JSON.parse(await fs.readFile(path.join(project, 'packaged-location.json'), 'utf8'))
function inside(relative) {
  assert.equal(typeof relative, 'string'); assert.equal(path.isAbsolute(relative), false)
  const result = path.resolve(project, relative), from = path.relative(project, result)
  assert.ok(from && from !== '..' && !from.startsWith('..' + path.sep) && !path.isAbsolute(from))
  return result
}
assert.equal(location.schema_version, 1)
const executable = inside(location.executable), core = inside(location.core)
const { inspectInstance } = await import(pathToFileURL(path.join(core, 'scripts/lib/instance-runtime.mjs')))
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 打包 ')), data = path.join(temporary, '实例 数据')
const env = { ...process.env, DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.CRABOT_DEV; delete env.CRABOT_PORT_OFFSET
const node = path.join(core, process.platform === 'win32' ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
const cli = async (...args) => (await promisify(execFile)(node, [path.join(core, 'cli.mjs'), ...args], { env, cwd: core, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout
const children = []
function launch() {
  const child = spawn(executable, ['--background'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = '', buffered = '', ended = false
  const phases = []
  const exited = new Promise(resolve => child.once('close', (code, signal) => { ended = true; resolve({ code, signal }) }))
  child.stdout.on('data', chunk => {
    const text = chunk.toString(); output = (output + text).slice(-128_000); buffered += text
    let end
    while ((end = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
      try { const event = JSON.parse(line); if (event.component === 'desktop') phases.push(event) } catch {}
    }
  })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-128_000) })
  child.on('error', error => { output += String(error); ended = true })
  async function phase(expected) {
    const deadline = Date.now() + 100_000
    while (Date.now() < deadline) {
      if (phases.some(event => event.phase === expected)) return
      if (ended || phases.some(event => ['error', 'migration_required'].includes(event.phase))) throw new Error('Packaged boot failed\n' + output)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Packaged phase timed out: ' + expected + '\n' + output)
  }
  return { child, exited, phase }
}
try {
  let gui = launch(); await gui.phase('ready')
  const first = inspectInstance(data)
  assert.equal(first.state, 'running'); assert.equal(first.record.install_root, await fs.realpath(core))
  assert.equal(JSON.parse(await cli('status', '--json')).running, true)
  gui.child.kill('SIGKILL'); await gui.exited
  assert.equal(inspectInstance(data).state, 'running')
  gui = launch(); await gui.phase('ready')
  assert.equal(inspectInstance(data).record.generation, first.record.generation)
  await cli('stop'); await gui.phase('stopped')
  assert.equal(inspectInstance(data).state, 'stopped')
  gui.child.kill('SIGKILL'); await gui.exited
  console.log('CRABOT_PACKAGED_BOOT ' + JSON.stringify({ platform: process.platform, arch: process.arch,
    packaged_asar_native_auth: true, installed_core_shared_with_cli: true, gui_crash_preserves_core: true, reattach_same_generation: true,
    cli_stop_stays_stopped: true, unicode_spaced_data: true, release_signed: false }))
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await cli('stop')
  assert.equal(inspectInstance(data).state, 'stopped', 'Unverified processes keep their disposable data for investigation')
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
