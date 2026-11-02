// Real final-package acceptance in an expendable Ubuntu GitHub VM.
import assert from 'node:assert/strict'
import { promises as fs, createReadStream } from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { probeMmModules } from '../../scripts/lib/mm-probe.mjs'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0)
const exec = promisify(execFile), distribution = path.resolve(process.argv[2])
const base = path.dirname(distribution), root = '/opt/Crabot', core = root + '/resources/core', entry = root + '/crabot-desktop'
const home = path.join(base, 'test-home'), data = home + '/share/crabot/data'
await fs.mkdir(home, { recursive: true, mode: 0o700 })
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home + '/config', XDG_DATA_HOME: home + '/share', XDG_CACHE_HOME: home + '/cache' }
for (const key of ['DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key]
async function readArtifact(directory) {
  const artifact = JSON.parse(await fs.readFile(path.join(directory, 'installers.json'), 'utf8'))
  const item = artifact.files.find(v => v.file.endsWith('.deb'))
  assert.equal(path.basename(item.file), item.file)
  const file = path.join(directory, item.file), hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  assert.equal(hash.digest('hex'), item.sha256)
  return { artifact, file }
}
const { artifact, file } = await readArtifact(distribution)
const baselinePath = process.argv.find(value => value.startsWith('--baseline='))?.slice('--baseline='.length)
const baseline = baselinePath ? await readArtifact(path.resolve(baselinePath)) : { artifact, file }
if (baselinePath) assert.notEqual(baseline.artifact.version, artifact.version, 'upgrade acceptance requires two distinct GUI/Core versions')
const report = { harness_source: process.env.GITHUB_SHA, version: artifact.version,
  initial_version: baseline.artifact.version, upgrade_fixture: baselinePath ? 'same source, two version stamps; not a released cross-version data migration' : null,
  system: (await fs.readFile('/etc/os-release', 'utf8')).trim(), environment: 'Native GitHub VM, Xvfb; GNOME/Wayland human acceptance not represented', checks: [] }
const children = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const command = async (file, args, options = {}) => (await exec(file, args, { timeout: 180000, maxBuffer: 2000000, ...options })).stdout
const cli = (...args) => command('/usr/bin/crabot', args, { env, timeout: 90000 })
const install = (selected = file) => command('/usr/bin/sudo', ['-n', '/usr/bin/apt-get', 'install', '--reinstall', '-y', selected])
async function healthyModules() {
  const deadline = Date.now() + 120000
  let failure
  while (Date.now() < deadline) {
    try {
      const modules = await probeMmModules(19000), result = []
      for (const id of ['admin-web', 'crabot-agent', 'memory-default']) {
        const module = modules?.find(item => item.module_id === id)
        assert.equal(module?.status, 'running', id + ' has not registered')
        const response = await fetch(`http://127.0.0.1:${module.port}/health`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
        const value = await response.json()
        assert.ok(response.ok && value.success && ['healthy', 'degraded'].includes(value.data.status), id + ' is not ready')
        result.push({ module: id, health: value.data.status })
      }
      return result
    } catch (error) { failure = error; await pause(500) }
  }
  throw failure
}
async function closeGui(gui) {
  if (gui.exitCode === null && gui.signalCode === null) { gui.kill('SIGKILL'); await Promise.race([once(gui, 'close'), pause(5000)]) }
}
async function launch(label, chooseDefault = false, expectedVersion = artifact.version) {
  const child = spawn(entry, [], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
  let output = '', selected = !chooseDefault
  const consume = bytes => { output = (output + bytes).slice(-100000) }
  child.stdout.on('data', consume); child.stderr.on('data', consume)
  const deadline = Date.now() + 180000
  while (!output.split('\n').some(line => { try { return JSON.parse(line).phase === 'ready' } catch { return false } }) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    if (!selected) {
      try {
        const windows = (await command('xdotool', ['search', '--onlyvisible', '--name', 'Crabot'], { timeout: 1000 })).trim().split('\n')
        if (windows.length && windows[0]) { await command('xdotool', ['windowfocus', '--sync', windows.at(-1), 'key', 'Return'], { timeout: 1000 }); selected = true }
      } catch {}
    }
    await pause(100)
  }
  await fs.writeFile(path.join(base, 'acceptance-' + label + '.log'), output)
  assert.ok(output.split('\n').some(line => { try { const v = JSON.parse(line); return v.component === 'desktop' && v.phase === 'ready' } catch { return false } }), label + ': ' + output.slice(-5000))
  const boot = output.split('\n').map(line => { try { return JSON.parse(line) } catch { return {} } }).find(v => v.component === 'desktop-bootstrap' && v.phase === 'app-ready')
  assert.equal(boot?.app_version, expectedVersion)
  assert.equal((await cli('--version')).trim(), expectedVersion)
  report.checks.push({ name: label, ready: true, app_version: boot.app_version, cli_version: expectedVersion, modules: await healthyModules() })
  return child
}
try {
  const restriction = (await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')).trim()
  assert.equal(restriction, '1')
  await install(baseline.file)
  const conffiles = await command('/usr/bin/dpkg-query', ['-W', '-f=${Conffiles}', 'crabot-desktop'])
  assert.match(conffiles, /\/etc\/apparmor.d\/crabot-desktop/)
  assert.equal((await fs.stat(entry)).uid, 0)
  const corePackage = JSON.parse(await fs.readFile(core + '/package.json', 'utf8'))
  assert.equal(corePackage.version, baseline.artifact.version)
  report.initial_package_source = JSON.parse(await fs.readFile(core + '/core-release.json', 'utf8')).commit
  const menu = await fs.readFile('/usr/share/applications/crabot.desktop', 'utf8')
  assert.match(menu, /Exec=.*\/opt\/Crabot\/crabot-desktop/)
  report.checks.push({ name: 'standard_install_fixed_program_and_conffile', menu, conffiles })
  let gui = await launch('first_default_location', true, baseline.artifact.version)
  const sandbox = JSON.parse(await command('/usr/bin/sudo', ['-n', '/usr/bin/python3', path.resolve('.github/scripts/ubuntu-renderer-sandbox.py'), String(gui.pid), String(process.getuid())]))
  report.checks.push({ name: 'actual_gui_renderer_kernel_sandbox', ...sandbox })
  const binding = JSON.parse(await fs.readFile(home + '/config/crabot/desktop-binding.json', 'utf8'))
  assert.equal(binding.data_dir, data); assert.equal(binding.core_root, core)
  const status = JSON.parse(await cli('status', '--json')); assert.equal(status.running, true)
  // Fresh native desktop access does not require a browser password. Add one only
  // in this synthetic test account, so upgrade retention checks a real credential.
  const seedPassword = 'import{pathToFileURL}from"node:url";const m=await import(pathToFileURL(process.argv[1]));await m.createCredentialsIfAbsent(process.argv[2],await m.newCredentialsFromPassword("isolated-deb-acceptance",{is_temp:false,changed_via:"start"}))'
  await command(core + '/.product-runtime/node/bin/node', ['--input-type=module', '-e', seedPassword, core + '/crabot-admin/dist/credentials.js', data + '/admin'])
  const credentials = await fs.readFile(data + '/admin/credentials.json')
  if (process.env.CRABOT_CI_DEVELOPMENT_COEXISTENCE === '1') {
    const { prepareCiElectronSandbox } = await import('./ubuntu-electron-test-sandbox.mjs')
    const { createRequire } = await import('node:module')
    await prepareCiElectronSandbox(createRequire(path.resolve('crabot-desktop/package.json'))('electron'))
    const { inspectInstance } = await import('../../scripts/lib/instance-runtime.mjs')
    const { verifyDevelopmentCoexistence } = await import('./smoke-development-coexistence.mjs')
    await verifyDevelopmentCoexistence({ inspectRelease: async () => inspectInstance(data), releaseCli: cli })
    report.checks.push({ name: 'actual_source_gui_and_release_data_generation_and_stop_isolation', passed: true })
  }
  const browser = await command(core + '/.product-runtime/node/bin/node', [path.resolve('.github/scripts/smoke-scrapling.mjs'), core, '--offline', '--kernel-check'], { env, timeout: 240000 })
  await fs.writeFile(path.join(base, 'acceptance-browser.log'), browser)
  report.checks.push({ name: 'actual_production_mcp_browser_and_kernel_sandbox', output: browser })
  let refused = false
  try { await install() } catch (error) { refused = true; assert.match(error.stdout + error.stderr, /Crabot 仍在运行/); report.checks.push({ name: 'running_reinstall_refused_without_signal', output: error.stdout + error.stderr }) }
  assert.ok(refused); assert.equal(gui.exitCode, null); assert.equal(JSON.parse(await cli('status', '--json')).running, true)
  const before = JSON.parse(await fs.readFile(data + '/instance-runtime.json', 'utf8'))
  const secret = randomBytes(32); await fs.writeFile(data + '/acceptance-sentinel', secret, { mode: 0o600 })
  await closeGui(gui); await pause(1500)
  assert.equal(JSON.parse(await cli('status', '--json')).running, true)
  assert.equal(JSON.parse(await fs.readFile(data + '/instance-runtime.json', 'utf8')).mm.pid, before.mm.pid)
  gui = await launch('reopen_same_data_and_core', false, baseline.artifact.version)
  await cli('stop'); assert.equal(JSON.parse(await cli('status', '--json')).running, false); await closeGui(gui)
  const profile = '/etc/apparmor.d/crabot-desktop'
  await command('/usr/bin/sudo', ['-n', '/bin/sh', '-c', 'echo "# administrator-preserved-acceptance" >> /etc/apparmor.d/crabot-desktop'])
  await install()
  assert.match(await fs.readFile(profile, 'utf8'), /administrator-preserved-acceptance/)
  gui = await launch('stopped_fixed_overwrite_preserves_binding')
  report.package_source = JSON.parse(await fs.readFile(core + '/core-release.json', 'utf8')).commit
  assert.deepEqual(await fs.readFile(data + '/acceptance-sentinel'), secret)
  assert.deepEqual(await fs.readFile(data + '/admin/credentials.json'), credentials)
  assert.deepEqual(JSON.parse(await fs.readFile(home + '/config/crabot/desktop-binding.json', 'utf8')), binding)
  await cli('stop'); await closeGui(gui)
  await command('/usr/bin/sudo', ['-n', '/usr/bin/dpkg', '--remove', 'crabot-desktop'])
  await assert.rejects(fs.stat(entry), { code: 'ENOENT' }); assert.deepEqual(await fs.readFile(data + '/acceptance-sentinel'), secret)
  const loaded = await command('/usr/bin/sudo', ['-n', '/bin/cat', '/sys/kernel/security/apparmor/profiles'])
  assert.doesNotMatch(loaded, /^crabot-desktop-(?:gui|chromium|headless) /m)
  await install(); gui = await launch('reinstall_existing_binding'); await cli('stop'); await closeGui(gui)
  assert.deepEqual(await fs.readFile(data + '/acceptance-sentinel'), secret)
  assert.deepEqual(await fs.readFile(data + '/admin/credentials.json'), credentials)
  assert.equal((await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')).trim(), restriction)
  report.checks.push({ name: 'stop_overwrite_remove_reinstall_preserves_data_and_admin_configuration', passed: true })
} catch (error) { report.failure = { message: error.message, code: error.code, stdout: error.stdout, stderr: error.stderr }; process.exitCode = 1 }
finally {
  try { await cli('stop') } catch {}
  for (const gui of children) await closeGui(gui)
  await fs.writeFile(path.join(base, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('CRABOT_DEB_ACCEPTANCE ' + JSON.stringify(report))
}
