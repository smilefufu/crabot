// Published old program archive -> real installer -> ordinary target Main/CLI.
// Dialog input and stopped historical data are fixtures; product lifecycle is not.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { stoppedLegacyModules } from '../../scripts/lib/__tests__/fixtures/stopped-legacy-modules.mjs'
import { discoverLegacyUserInstall } from '../../scripts/lib/legacy-desktop.mjs'
import { fenceLegacyEntries } from '../../scripts/lib/legacy-entry-fence.mjs'
import { buildLegacyInstallerDriver } from './build-legacy-installer-driver.mjs'
import { verifyDesktopPayload } from '../../scripts/lib/desktop-payload.mjs'
import { inspectInstance, identity } from '../../scripts/lib/instance-runtime.mjs'
import { stopInstance } from '../../scripts/lib/instance-controller.mjs'
import { probeHealthStatus, probeMmModules } from '../../scripts/lib/mm-probe.mjs'
import installation from '../../scripts/lib/desktop-installation.cjs'
import product from '../../scripts/lib/product-runtime.cjs'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.ok(['darwin', 'win32', 'linux'].includes(process.platform))
const repository = path.resolve('.'), project = await fs.realpath(process.argv[2]), installer = await fs.realpath(process.argv[3])
assert.ok(['.desktop-build/安装 候选/paired', '.desktop-build/manual/paired'].some(value => project === path.join(repository, value)))
assert.equal(installer, path.join(path.dirname(project), 'installer'))
const target = await verifyDesktopPayload(path.join(project, 'offline'))
const platform = (process.platform === 'win32' ? 'windows' : process.platform) + '-' + process.arch
const archives = JSON.parse(await fs.readFile(new URL('fixtures/legacy-desktop-archives.json', import.meta.url), 'utf8'))
const requestedVersion = process.argv[4]
assert.ok(process.argv.length <= 5 && (requestedVersion === undefined || Object.hasOwn(archives, requestedVersion)), 'Unknown historical fixture version')
const versions = requestedVersion ? [requestedVersion] : Object.keys(archives), suffix = requestedVersion ? '-' + requestedVersion : ''
const execute = promisify(execFile), reports = [], temporary = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'linux' ? homedir() : tmpdir(), 'Crabot 原位接管 ')))
const driverRoot = path.join(repository, '.desktop-build/legacy-installer-' + randomUUID()), evidence = path.join(repository, '.desktop-build/legacy-user-takeover' + suffix + '.json')
let output = '', allPassed = false
async function space() { for (const directory of [repository, temporary]) { const value = await fs.statfs(directory, { bigint: true }); assert.ok(value.bavail * value.bsize > target.bytes * 5n + 4n * 1024n ** 3n, 'Legacy acceptance copy-space prerequisite') } }
async function absent(file) { try { await fs.lstat(file); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error } }
async function download(version, destination) {
  const [size, sha256] = archives[version][platform], extension = process.platform === 'win32' ? '.zip' : '.tar.gz'
  const response = await fetch('https://github.com/smilefufu/crabot/releases/download/' + version + '/crabot-' + version + '-' + platform + extension, { signal: AbortSignal.timeout(120000) })
  assert.ok(response.ok && response.body, 'Published archive download: ' + response.status)
  let bytes = 0
  await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
    for await (const chunk of chunks) { bytes += chunk.length; assert.ok(bytes <= size); yield chunk }
  }, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  assert.equal(bytes, size)
  const hash = createHash('sha256'); for await (const chunk of createReadStream(destination)) hash.update(chunk)
  assert.equal(hash.digest('hex'), sha256)
}
async function runUbuntuInstaller({ bundle, root, env, control, version }) {
  const node = path.join(bundle, 'offline/core/.product-runtime/node/bin/node')
  const child = spawn(node, [path.join(bundle, 'backend/dist/ubuntu-installer-backend.js'), root], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const ended = once(child, 'close'); let failure, complete = false, processing = Promise.resolve()
  child.stdin.on('error', error => { failure ??= error })
  child.stderr.on('data', bytes => { output = (output + bytes.toString()).slice(-128000) })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    processing = processing.then(async () => {
      assert.ok(Buffer.byteLength(line) <= 65536)
      const frame = JSON.parse(line)
      if (frame.type === 'legacy_takeover_required') {
        assert.equal(frame.install_root, root); assert.equal(frame.version, version)
        await fs.writeFile(path.join(control, 'takeover-confirmed.json'), JSON.stringify({ detail: frame.version }) + '\n', { flag: 'wx' })
        child.stdin.write('{"action":"takeover"}\n')
      } else if (frame.type === 'authorization_required') {
        // Only authorization transport is substituted. The actual native helper
        // still validates and registers the exact prepared GUI/browser programs.
        await execute('/usr/bin/sudo', ['-n', '/usr/bin/env', 'PKEXEC_UID=' + process.getuid(), path.join(bundle, 'crabot-sandbox-helper'), '--register', root],
          { env, timeout: 120000, maxBuffer: 65536 })
        child.stdin.write('{"action":"authorized"}\n')
      } else if (frame.type === 'complete') {
        assert.equal(frame.verification_pending, true); complete = true
        await fs.writeFile(path.join(control, 'installer-handoff.json'), 'true\n', { flag: 'wx' })
      } else if (frame.type === 'failed') throw new Error('Actual Ubuntu legacy installer: ' + JSON.stringify(frame))
      else assert.equal(frame.type, 'progress')
    }).catch(error => { failure ??= error; if (child.stdin.writable) child.stdin.write('{"action":"cancel"}\n') })
  })
  const timer = setTimeout(() => { failure ??= new Error('Ubuntu installer acceptance timed out'); if (child.stdin.writable) child.stdin.write('{"action":"cancel"}\n') }, 600000)
  try {
    const [code] = await ended; await processing
    if (failure) throw failure
    assert.equal(code, 0, output); assert.equal(complete, true)
  } finally { clearTimeout(timer); lines.close(); child.stdin.destroy() }
}
try {
  await space()
  const linux = process.platform === 'linux', bundle = path.join(installer, 'ubuntu-native')
  const singleLayer = process.platform === 'win32'
  const driver = linux || singleLayer ? null : await buildLegacyInstallerDriver({ repository, installer, destination: driverRoot, payload: target.directory })
  for (const version of versions) {
    await space()
    const home = path.join(temporary, version), programRoot = singleLayer ? path.join(repository, '.desktop-build/first-use-' + randomUUID()) : path.join(home, '.crabot'), root = path.join(home, '.crabot'), dataDir = path.join(root, 'data'), control = path.join(home, 'control')
    await fs.mkdir(control, { recursive: true, mode: 0o700 })
    const archive = path.join(home, process.platform === 'win32' ? 'old.zip' : 'old.tar.gz'), extracted = path.join(home, 'extracted')
    let gui, exited, peer, prepared, stale, passed = false
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local') }
    if (process.platform === 'win32') {
      // Real Windows profiles already contain these OS-owned parent locations.
      // Keep the disposable profile valid before Chromium's native startup.
      for (const directory of [env.APPDATA, env.LOCALAPPDATA]) await fs.mkdir(directory, { recursive: true })
    }
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'WORKER_WORKSPACES_DIR']) delete env[name]
    const stage = name => console.log('CRABOT_LEGACY_USER_STAGE ' + JSON.stringify({ version, stage: name }))
    try {
      stage('published-archive')
      await download(version, archive); await fs.mkdir(extracted)
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/tar.exe') : '/usr/bin/tar'
      await execute(tar, ['-xf', path.basename(archive), '-C', 'extracted'], { cwd: home, timeout: 180000, maxBuffer: 65536 })
      const children = await fs.readdir(extracted); assert.equal(children.length, 1)
      await fs.rename(path.join(extracted, children[0]), root); await fs.writeFile(path.join(root, 'VERSION'), version + '\n')
      if (process.platform === 'win32') await execute(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-File', path.join(repository, 'scripts/lib/__tests__/fixtures/legacy-windows-launcher.ps1'), '-Directory', root, '-PrivateNode'], { env, timeout: 30000 })
      await fs.mkdir(dataDir, { recursive: true, mode: 0o755 })
      for (const name of ['admin', 'agent', 'memory']) {
        const directory = path.join(dataDir, name), marker = path.join(root, 'crabot-' + name, 'schema_version')
        await fs.mkdir(directory, { mode: 0o755 }); if (!await absent(marker)) await fs.copyFile(marker, path.join(directory, 'SCHEMA_VERSION'))
      }
      const { newCredentialsFromPassword } = await import(pathToFileURL(path.join(target.coreRoot, 'crabot-admin/dist/credentials.js')))
      const credentials = JSON.stringify(await newCredentialsFromPassword('fixture-legacy-password', { is_temp: false, changed_via: 'start' }))
      await fs.writeFile(path.join(dataDir, 'admin/credentials.json'), credentials, { mode: 0o600 })
      const sentinels = ['agent/preserved-history.txt', 'memory/preserved.txt', 'mcp-deps/preserved.txt', 'workspaces/old-project/content.txt']
      for (const file of sentinels) { await fs.mkdir(path.dirname(path.join(dataDir, file)), { recursive: true }); await fs.writeFile(path.join(dataDir, file), 'retained ' + version + '\n') }
      const prefix = path.join(home, '.local/bin'), command = process.platform === 'win32' ? path.join(root, 'crabot.cmd') : path.join(prefix, 'crabot')
      if (process.platform !== 'win32') { await fs.mkdir(prefix, { recursive: true }); await fs.symlink(path.join(root, 'cli.mjs'), command) }
      env.PATH = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'
      const config = path.join(control, 'config.json')
      await fs.writeFile(config, JSON.stringify({ control, installRoot: root }) + '\n', { mode: 0o600 })
      env.CRABOT_LEGACY_INSTALLER_DRIVER = config
      if (process.platform === 'win32' && version === 'v2026.10.14.1') {
        // Field feedback: the old instance is stopped, but a previous attempt
        // has fenced entries and left three old module records behind.
        stale = await stoppedLegacyModules(dataDir)
        const source = await discoverLegacyUserInstall({ root, dataDir, source: env })
        await fenceLegacyEntries(source)
        assert.equal(await absent(path.join(dataDir, 'desktop-maintenance.json')), true)
        stage('stopped-v14-fenced-with-three-module-records')
      }
      stage('actual-installer')
      if (linux) {
        Object.assign(env, { XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
          XDG_CACHE_HOME: path.join(home, 'cache'), XDG_RUNTIME_DIR: path.join(home, 'run'), GDK_BACKEND: 'x11' })
        for (const name of ['config', 'share', 'cache', 'run']) await fs.mkdir(path.join(home, name), { mode: 0o700 })
        await runUbuntuInstaller({ bundle, root, env, control, version })
      } else if (singleLayer) {
        const directory = path.join(installer, 'distribution'), files = (await fs.readdir(directory)).filter(name => name.endsWith('offline-candidate.exe'))
        assert.equal(files.length, 1)
        await execute(path.join(directory, files[0]), ['/S', '/D=' + programRoot], { env, windowsVerbatimArguments: true, timeout: 600000, maxBuffer: 65536 })
        assert.equal(await absent(path.join(root, 'releases', target.record.selection.core_id)), true, 'Installer must not copy new programs to the old root')
        assert.equal(await absent(path.join(programRoot, 'data')), true)
        const executable = path.join(programRoot, 'app/releases', target.record.selection.gui_id, 'Crabot.exe')
        gui = spawn(executable, ['--background'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        peer = identity.inspectProcess(gui.pid); assert.ok(peer); exited = once(gui, 'exit'); void exited.catch(() => {})
        gui.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-128000) })
        gui.stderr.on('data', bytes => { output = (output + bytes.toString()).slice(-128000) })
        const confirmation = await execute(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-File', path.join(repository, '.github/scripts/accept-windows-legacy-data-dialog.ps1'), '-GuiPid', String(gui.pid), '-DataDirectory', dataDir, '-Version', version], { env, timeout: 250000, maxBuffer: 65536 })
        output += confirmation.stdout + confirmation.stderr
        const selectedBy = Date.now() + 180000
        while (true) {
          try { installation.readDesktopSelection(programRoot); break } catch (error) {
            if (gui.exitCode !== null || Date.now() >= selectedBy) throw new Error('Actual GUI data handoff failed: ' + error.message + '\n' + output)
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }
      } else {
        try {
          const installed = await execute(driver, ['--enable-logging=file', '--log-file=' + path.join(control, 'installer-native.log')], { env, timeout: 600000, maxBuffer: 256000 }); output += installed.stdout + installed.stderr
        } catch (error) {
          output += String(error.stdout ?? '') + String(error.stderr ?? '')
          output += '\nCRABOT_LEGACY_INSTALLER_EXIT ' + JSON.stringify({ code: error.code, signal: error.signal, killed: error.killed }) + '\n'
          throw error
        }
      }
      if (!singleLayer) {
        assert.equal(JSON.parse(await fs.readFile(path.join(control, 'installer-handoff.json'), 'utf8')), true)
        assert.ok(JSON.parse(await fs.readFile(path.join(control, 'takeover-confirmed.json'), 'utf8')).detail.includes(version))
      }
      const own = installation.readDesktopSelection(programRoot)
      prepared = { installRoot: programRoot, installation_id: own.record.installation_id, selection: own.selection, coreRoot: own.coreRoot, guiRoot: own.guiRoot }
      assert.equal(own.dataDir, dataDir); assert.deepEqual(own.selection, target.record.selection)
      if (!singleLayer) assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'desktop-maintenance.json'), 'utf8')).phase, 'verifying')
      if (stale) for (const file of stale.files) assert.equal(await absent(file), true, 'Exited legacy record must settle before ordinary Main')
      stage('ordinary-target-main')
      if (!gui) { gui = spawn(own.executable, ['--background'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); peer = identity.inspectProcess(gui.pid); assert.ok(peer); exited = once(gui, 'exit'); void exited.catch(() => {}) }
      let ready = singleLayer && output.split('\n').some(line => { try { const value = JSON.parse(line); return value.component === 'desktop' && value.phase === 'ready' } catch { return false } }), buffered = '', failed
      gui.on('error', error => { failed = error })
      gui.stderr.on('data', bytes => { output = (output + bytes.toString()).slice(-128000) })
      gui.stdout.on('data', bytes => {
        buffered += bytes.toString(); output = (output + bytes.toString()).slice(-128000)
        let end
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
          try { const event = JSON.parse(line); if (event.component === 'desktop' && event.phase === 'ready') ready = true; if (event.component === 'desktop' && ['error', 'migration_required'].includes(event.phase)) failed = new Error(line) } catch {}
        }
      })
      const deadline = Date.now() + (process.platform === 'darwin' && process.arch === 'x64' ? 360000 : 180000)
      while (!ready || !await absent(path.join(dataDir, 'desktop-maintenance.json'))) {
        if (failed || gui.exitCode !== null || Date.now() >= deadline) throw failed || new Error('Ordinary legacy target did not become healthy: ' + output)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const instance = inspectInstance(dataDir); assert.equal(instance.state, 'running'); assert.equal(instance.record.install_root, own.coreRoot)
      const nativeCli = path.join(programRoot, 'bin', process.platform === 'win32' ? 'crabot.exe' : 'crabot')
      const nativeStatus = JSON.parse((await execute(nativeCli, ['status', '--json'], { env, timeout: 30000, maxBuffer: 128000 })).stdout)
      assert.equal(nativeStatus.running, true); assert.equal(nativeStatus.data_dir, dataDir)
      if (process.platform === 'win32') {
        const script = path.join(control, 'probe.cmd'); await fs.writeFile(script, '@echo off\r\ncall "%CRABOT_OLD_COMMAND%" status --json\r\nexit /b %errorlevel%\r\n')
        const original = await execute(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/c', script], { env: { ...env, CRABOT_OLD_COMMAND: command }, timeout: 30000, maxBuffer: 128000 })
        assert.equal(JSON.parse(original.stdout).running, true)
      } else {
        assert.equal(await fs.readlink(command), nativeCli)
        assert.equal(JSON.parse((await execute(command, ['status', '--json'], { env: { ...env, PATH: '/no-host-node' }, timeout: 30000, maxBuffer: 128000 })).stdout).running, true)
      }
      assert.equal(await fs.readFile(path.join(dataDir, 'admin/credentials.json'), 'utf8'), credentials)
      for (const file of sentinels) assert.equal(await fs.readFile(path.join(dataDir, file), 'utf8'), 'retained ' + version + '\n')
      const runtime = product.loadProductRuntime(own.coreRoot, { required: true, full: true })
      const scriptFile = path.join(dataDir, 'workspaces/old-project/new-script.txt')
      await execute(runtime.executables.python, ['-c', 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("old workspace usable")', scriptFile], { env, timeout: 10000 })
      assert.equal(await fs.readFile(scriptFile, 'utf8'), 'old workspace usable')
      assert.equal(inspectInstance(dataDir).record.generation, instance.record.generation)
      reports.push({ version, platform, published_archive_verified: true, official_windows_installer_launcher: process.platform === 'win32', actual_installer_loaded: true, single_layer_exe: singleLayer, actual_gui_first_use: singleLayer, native_dialog_input_substituted: !linux && !singleLayer, actual_ubuntu_backend: linux,
        graphical_polkit_tested: false, actual_gtk_flow_driven: false,
        old_data_fixture_stopped: true, old_fenced_stale_records_settled: Boolean(stale), ordinary_main_core_healthy: true, actual_native_and_original_cli_same_instance: true, host_node_required: false,
        original_credentials_and_sentinels_preserved: true, actual_bundled_python_file_access: true, historical_user_data_fixture: true,
        historical_user_model_session_tested: false, business_model_calls: 0 })
      await fs.writeFile(evidence, JSON.stringify({ complete: false, cases: reports }) + '\n')
      passed = true; stage('verified')
    } finally {
      if (!passed) {
        const diagnostics = []
        try {
          const state = inspectInstance(dataDir), record = state.record
          const modules = record ? await probeMmModules(record.mm_port) : null
          const statuses = new Set(['registered', 'starting', 'running', 'stopping', 'stopped', 'error', 'disconnected'])
          diagnostics.push({ name: 'startup-health', state: state.state,
            controller_alive: !!record && identity.sameProcess(record.controller, identity.inspectProcess(record.controller.pid)),
            mm_alive: !!record?.mm && identity.sameProcess(record.mm, identity.inspectProcess(record.mm.pid)),
            mm_health: record ? await probeHealthStatus(record.mm_port) : null,
            modules: modules?.filter(module => ['admin-web', 'crabot-agent', 'crabot-memory'].includes(module.module_id))
              .map(module => ({ module_id: module.module_id, status: statuses.has(module.status) ? module.status : 'unknown' })) ?? null })
        } catch { diagnostics.push({ name: 'startup-health', unavailable: true }) }
        for (const name of ['driver-started.json', 'driver-ready.json', 'driver-imported.json', 'driver-quit.json', 'driver-failed.json', 'takeover-confirmed.json', 'installer-handoff.json']) {
          try { diagnostics.push({ name, value: JSON.parse(await fs.readFile(path.join(control, name), 'utf8')) }) }
          catch (error) { if (error.code !== 'ENOENT') diagnostics.push({ name, unavailable: true }) }
        }
        try { diagnostics.push({ name: 'installer-native.log', text: (await fs.readFile(path.join(control, 'installer-native.log'), 'utf8')).slice(-32000) }) }
        catch (error) { if (error.code !== 'ENOENT') diagnostics.push({ name: 'installer-native.log', unavailable: true }) }
        if (process.platform === 'win32') diagnostics.push({ name: 'native-crash-frame', frames: await (await import('./read-ci-crash-frame.mjs')).readCiCrashFrames(path.join(control, 'crashes')) })
        await fs.writeFile(path.join(repository, '.desktop-build/legacy-user-diagnostic' + suffix + '.json'), JSON.stringify({ version, platform, diagnostics }) + '\n')
      }
      if (!await absent(dataDir) && inspectInstance(dataDir).state === 'running') await stopInstance(dataDir)
      if (peer && identity.sameProcess(peer, identity.inspectProcess(peer.pid))) process.kill(peer.pid, 'SIGKILL')
      if (exited) await exited
      if (passed && prepared) {
        const cleanup = path.join(control, 'cleanup.json'); await fs.writeFile(cleanup, JSON.stringify({ control, cleanup: true, prepared }) + '\n')
        if (linux) {
          const { removeInstallationEntries } = await import(pathToFileURL(path.join(bundle, 'backend/dist/installation-removal.js')))
          await removeInstallationEntries(prepared, { home, platform: 'linux', env,
            shell: { readShortcutLink: () => { throw new Error('Windows only') } },
            verifyStopped: async () => assert.equal(inspectInstance(dataDir).state, 'stopped') })
          await fs.writeFile(path.join(control, 'entries-cleaned.json'), 'true\n')
        } else if (singleLayer) {
          const script = path.join(control, 'cleanup-entries.cjs')
          await fs.writeFile(script, `const{app,shell}=require('electron');app.whenReady().then(async()=>{try{const{removeInstallationEntries}=await import(${JSON.stringify(pathToFileURL(path.join(repository, 'crabot-desktop/dist/installation-removal.js')).href)});const{inspectInstance}=await import(${JSON.stringify(pathToFileURL(path.join(repository, 'scripts/lib/instance-runtime.mjs')).href)});await removeInstallationEntries(${JSON.stringify(prepared)},{home:${JSON.stringify(home)},platform:'win32',env:process.env,shell,verifyStopped:async()=>{if(inspectInstance(${JSON.stringify(dataDir)}).state!=='stopped')throw Error('not stopped')}});require('fs').writeFileSync(${JSON.stringify(path.join(control, 'entries-cleaned.json'))},'true\n');app.exit(0)}catch(error){console.error(error);app.exit(1)}})`)
          const { createRequire } = await import('node:module'), require = createRequire(new URL('../../crabot-desktop/package.json', import.meta.url))
          await execute(require('electron'), [script], { env, timeout: 90000, maxBuffer: 65536 })
          await fs.rm(programRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } else await execute(driver, [], { env: { ...env, CRABOT_LEGACY_INSTALLER_DRIVER: cleanup }, timeout: 90000, maxBuffer: 128000 })
        assert.equal(JSON.parse(await fs.readFile(path.join(control, 'entries-cleaned.json'), 'utf8')), true)
        await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  }
  allPassed = true
  // Ubuntu sandbox rules belong to this disposable CI VM and end with it.
  // This fixture never claims to validate product uninstall or graphical Polkit.
} finally {
  await fs.writeFile(path.join(repository, '.desktop-build/legacy-user-takeover' + suffix + '.log'), output)
  await fs.writeFile(evidence, JSON.stringify({ complete: allPassed, cases: reports }) + '\n')
  if (allPassed) { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await fs.rm(driverRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
