// Disposable CI only: replace the delivered Mac App at the same location, retaining its data.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs, constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'darwin')
const execute = promisify(execFile), temporary = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'mac-overwrite-'))
const home = path.join(temporary, 'home'), app = path.join(temporary, 'Crabot.app'), data = path.join(home, 'data')
await fs.mkdir(home, { mode: 0o700 })
const env = { ...process.env, HOME: home, DATA_DIR: data }
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'WORKER_WORKSPACES_DIR']) delete env[key]
let gui, output = '', core, node, registered
const report = { platform: process.platform, arch: process.arch, native_first_use_dialog_tested: false }
const hash = async file => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex') }
const load = name => import(pathToFileURL(path.join(core, 'scripts/lib', name)).href)
async function extract(directory, name) {
  const files = await fs.readdir(directory, { recursive: true }), dmg = files.filter(file => file.endsWith('.dmg'))
  assert.equal(dmg.length, 1)
  const expected = (await fs.readFile(path.join(directory, path.dirname(dmg[0]), 'SHA256SUMS'), 'utf8')).split('\n').find(line => line.trim().endsWith(path.basename(dmg[0])))?.split(/\s+/)[0]
  assert.match(expected ?? '', /^[a-f0-9]{64}$/); assert.equal(await hash(path.join(directory, dmg[0])), expected)
  const mount = path.join(temporary, name + '-mount'), destination = path.join(temporary, name + '.app')
  await fs.mkdir(mount)
  await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.join(directory, dmg[0])], { timeout: 120000 })
  try { await fs.cp(path.join(mount, 'Crabot.app'), destination, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE }) }
  finally { await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 60000 }) }
  return destination
}
async function launch() {
  const started = performance.now(); let ready = false, failure, buffered = ''
  gui = spawn(path.join(app, 'Contents/MacOS/Crabot'), ['--background'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  gui.once('error', error => { failure = error })
  gui.stderr.on('data', bytes => { output = (output + bytes).slice(-128000) })
  gui.stdout.on('data', bytes => {
    output = (output + bytes).slice(-128000); buffered += bytes
    let end
    while ((end = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
      try { const frame = JSON.parse(line); if (frame.component === 'desktop' && frame.phase === 'ready') ready = true; if (frame.component === 'desktop' && ['error', 'migration_required'].includes(frame.phase)) failure = new Error(line) } catch {}
    }
  })
  while (!ready) {
    if (failure || gui.exitCode !== null || gui.signalCode !== null || performance.now() - started > 240000) throw failure ?? new Error('App did not reach ready\n' + output)
    await new Promise(done => setTimeout(done, 100))
  }
  return Math.round(performance.now() - started)
}
async function cli(...args) { return execute(node, [path.join(core, 'cli.mjs'), ...args], { env, timeout: 120000, maxBuffer: 2 * 1024 ** 2 }) }
async function stop() {
  await cli('stop')
  assert.equal(JSON.parse((await cli('status', '--json')).stdout).running, false)
  if (gui && gui.exitCode === null && gui.signalCode === null) { const exited = once(gui, 'close'); gui.kill('SIGKILL'); await exited }
}
try {
  const old = await extract(path.resolve(process.argv[2]), 'old'), next = await extract(path.resolve(process.argv[3]), 'new')
  await fs.cp(old, app, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  core = path.join(app, 'Contents/Resources/core'); node = path.join(core, '.product-runtime/node/bin/node')
  const management = (await load('desktop-management.cjs')).default, binding = (await load('mac-app-binding.cjs')).default
  management.ensurePrivateDataRoot(data); management.initializeDesktopManagement(data); binding.writeMacAppBinding({ appPath: app, dataDir: data, home })
  report.source_ready_ms = await launch()
  const before = JSON.parse((await cli('status', '--json')).stdout), runtimeBefore = JSON.parse(await fs.readFile(path.join(data, 'instance-runtime.json'), 'utf8'))
  report.from = JSON.parse(await fs.readFile(path.join(core, 'core-release.json'), 'utf8')).version; assert.equal(report.from, '0.1.0-desktop.11')
  assert.equal(before.running, true)
  const { installDesktopCli } = await load('desktop-cli-install.mjs'); registered = await installDesktopCli({ coreRoot: core, dataDir: data, home, env })
  const sentinels = ['agent/overwrite-preserved.txt', 'memory/overwrite-preserved.txt', 'workspaces/project/overwrite-preserved.txt']
  for (const file of sentinels) { await fs.mkdir(path.dirname(path.join(data, file)), { recursive: true }); await fs.writeFile(path.join(data, file), file) }
  await stop()
  const credentials = path.join(data, 'admin/credentials.json'), credentialHash = await hash(credentials)
  const started = performance.now(); await fs.rm(app, { recursive: true }); await fs.cp(next, app, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE }); report.replace_ms = Math.round(performance.now() - started)
  report.target_ready_ms = await launch()
  report.to = JSON.parse(await fs.readFile(path.join(core, 'core-release.json'), 'utf8')).version; assert.equal(report.to, '0.1.0-desktop.19')
  const boot = (await fs.readFile(path.join(data, 'desktop-profile/bootstrap.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(boot.some(frame => frame.phase === 'app-ready' && frame.app_version === report.to)); report.actual_gui_version = report.to
  const after = JSON.parse((await cli('status', '--json')).stdout), runtimeAfter = JSON.parse(await fs.readFile(path.join(data, 'instance-runtime.json'), 'utf8'))
  assert.equal(after.running, true); assert.equal(after.data_dir, data); assert.equal(runtimeAfter.instance_id, runtimeBefore.instance_id); assert.notEqual(runtimeAfter.generation, runtimeBefore.generation)
  assert.equal(await hash(credentials), credentialHash)
  for (const file of sentinels) assert.equal(await fs.readFile(path.join(data, file), 'utf8'), file)
  assert.equal((await execute(registered.command, ['--version'], { env, timeout: 30000 })).stdout.trim(), report.to)
  await stop(); report.second_target_ready_ms = await launch(); await stop()
  Object.assign(report, { same_app_location: true, data_preserved: true, credentials_preserved: true, same_instance: true, registered_cli_updated: true, stop_start_repeated: true, passed: true })
} catch (error) { report.error = error.message; throw error }
finally {
  try { if (core && node) await stop() } catch (error) { report.cleanup_error = error.message }
  await fs.mkdir('.desktop-build', { recursive: true }); await fs.writeFile('.desktop-build/mac-overwrite-report.json', JSON.stringify(report, null, 2) + '\n'); await fs.writeFile('.desktop-build/mac-overwrite.log', output)
  if (report.passed && !report.cleanup_error) await fs.rm(temporary, { recursive: true, force: true })
}
