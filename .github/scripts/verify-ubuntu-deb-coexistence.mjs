// Same installed DEB and existing isolated data, after independent package acceptance.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { prepareCiElectronSandbox } from './ubuntu-electron-test-sandbox.mjs'
import { verifyDevelopmentCoexistence } from './smoke-development-coexistence.mjs'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0)
const base = path.dirname(path.resolve(process.argv[2])), home = base + '/test-home', data = home + '/share/crabot/data'
const core = '/opt/Crabot/resources/core', exec = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const artifact = JSON.parse(await fs.readFile(path.join(base, 'distribution/installers.json'), 'utf8'))
const binding = JSON.parse(await fs.readFile(home + '/config/crabot/desktop-binding.json', 'utf8'))
assert.equal(binding.data_dir, data); assert.equal(binding.core_root, core)
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home + '/config', XDG_DATA_HOME: home + '/share', XDG_CACHE_HOME: home + '/cache' }
for (const key of ['DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key]
const cli = async (...args) => (await exec('/usr/bin/crabot', args, { env, timeout: 90000, maxBuffer: 2000000 })).stdout
assert.equal((await cli('--version')).trim(), artifact.version)
await prepareCiElectronSandbox(createRequire(path.resolve('crabot-desktop/package.json'))('electron'))
const { inspectInstance } = await import(pathToFileURL(core + '/scripts/lib/instance-runtime.mjs'))
const gui = spawn('/opt/Crabot/crabot-desktop', ['--background'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
const consume = bytes => { output = (output + bytes).slice(-128000) }
gui.stdout.on('data', consume); gui.stderr.on('data', consume)
try {
  const deadline = Date.now() + 180000
  while (!output.split('\n').some(line => { try { const v = JSON.parse(line); return v.component === 'desktop' && v.phase === 'ready' } catch { return false } })) {
    assert.ok(gui.exitCode === null && gui.signalCode === null && Date.now() < deadline, output)
    await pause(100)
  }
  await verifyDevelopmentCoexistence({ inspectRelease: async () => inspectInstance(data), releaseCli: cli })
} finally {
  try { await cli('stop') } catch {}
  if (gui.exitCode === null && gui.signalCode === null) { const ended = once(gui, 'close'); gui.kill('SIGKILL'); await Promise.race([ended, pause(5000)]) }
  await fs.writeFile(path.join(base, 'acceptance-coexistence-gui.log'), output)
}
