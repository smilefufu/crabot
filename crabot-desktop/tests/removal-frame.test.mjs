import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { readInstanceRuntime, inspectInstance } from '../../scripts/lib/instance-runtime.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../../scripts/lib/core-release.mjs'
import { sealDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../../scripts/lib/desktop-payload.mjs'
import identity from '../../scripts/lib/process-identity.cjs'
import { probeKnownProcessExit } from '../../scripts/lib/known-process-exit.cjs'
import { buildUbuntuMaintenanceBackend } from '../../scripts/desktop/ubuntu-maintenance-backend.mjs'
import { prepareDesktopRemovalGui } from '../../scripts/lib/desktop-removal-host.mjs'
const linuxSource = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' && !!process.env.CRABOT_GTK_ACTOR
const supported = ['darwin', 'win32'].includes(process.platform) || linuxSource, repository = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
let root, payload
before(async () => {
  if (!supported) return
  root = await fs.realpath(await fs.mkdtemp(path.join(linuxSource ? homedir() : tmpdir(), 'crabot-protected-removal-frame-')))
  payload = path.join(root, 'payload'); const core = path.join(payload, 'core'), appDir = path.join(root, 'app')
  await fs.mkdir(path.join(core, 'bin'), { recursive: true })
  await fs.copyFile(path.join(repository, 'crabot-native/build/Release', process.platform === 'win32' ? 'crabot.exe' : 'crabot'), path.join(core, 'bin', process.platform === 'win32' ? 'crabot.exe' : 'crabot'))
  for (const name of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(core, name), JSON.stringify({ version: '1.2.3', ...(name === 'package.json' ? { type: 'module' } : {}) }))
  if (linuxSource) {
    await fs.mkdir(path.join(core, '.product-runtime/node/bin'), { recursive: true })
    await fs.copyFile(process.execPath, path.join(core, '.product-runtime/node/bin/node'))
    const runtimeDirectory = '.scrapling-runtime-fixture-0123456789abcdef-12345678'
    const browser = runtimeDirectory + '/browsers/chromium-1234/chrome-linux64/chrome'
    const binary = await fs.readFile(path.join(path.dirname(process.env.CRABOT_GTK_FRONTEND), 'crabot-sandbox-helper'))
    await fs.mkdir(path.dirname(path.join(core, browser)), { recursive: true }); await fs.writeFile(path.join(core, browser), binary, { mode: 0o755 })
    await fs.writeFile(path.join(core, 'scrapling-runtime.json'), JSON.stringify({ directory: runtimeDirectory }) + '\n')
    await fs.writeFile(path.join(core, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version: '1.2.3', platform: 'linux', arch: 'x64',
      versions: { node: process.versions.node }, browser: runtimeDirectory + '/chromium-launcher', files: { [browser]: { type: 'file', size: binary.length, sha256: (await import('node:crypto')).createHash('sha256').update(binary).digest('hex') } } }) + '\n')
  }
  await fs.mkdir(path.join(core, 'crabot-core/dist'), { recursive: true })
  await fs.copyFile(new URL('../../scripts/lib/__tests__/fixtures/core.mjs', import.meta.url), path.join(core, 'crabot-core/dist/main.js'))
  await fs.writeFile(path.join(core, 'program.mjs'), 'throw new Error("Never execute this minimal fixture Core")')
  await writeCoreRelease(core, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  await fs.writeFile(path.join(core, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }))
  const release = await verifyCoreRelease(core), selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: release.inventory_sha256 }
  await promisify(execFile)(process.execPath, ['build-preload.mjs'], { cwd: path.join(repository, 'crabot-desktop'), timeout: 30000, maxBuffer: 65536 })
  await fs.mkdir(path.join(appDir, 'dist'), { recursive: true })
  await fs.cp(path.join(repository, 'crabot-desktop/dist/bootstrap'), path.join(appDir, 'dist/bootstrap'), { recursive: true })
  await fs.copyFile(path.join(repository, 'scripts/lib/mode.mjs'), path.join(appDir, 'dist/bootstrap/scripts/lib/mode.mjs'))
  for (const name of ['installation-removal.js', 'installation-entries.js', 'login-startup.js', 'removal-operation.js']) await fs.copyFile(path.join(repository, 'crabot-desktop/dist', name), path.join(appDir, 'dist', name))
  await fs.copyFile(new URL('fixtures/removal-frame-actor.cjs', import.meta.url), path.join(appDir, 'dist/main.cjs'))
  await fs.copyFile(path.join(repository, 'crabot-desktop/dist/removal-preload.cjs'), path.join(appDir, 'dist/removal-preload.cjs'))
  await require('esbuild').build({ entryPoints: [path.join(repository, 'crabot-desktop/src/removal-source.ts')], outfile: path.join(appDir, 'dist/source-entry.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'original-fs'], logLevel: 'silent' })
  await require('esbuild').build({ entryPoints: [path.join(repository, 'crabot-desktop/src/main.ts')], outfile: path.join(appDir, 'dist/full-main.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'original-fs'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" }, logLevel: 'silent' })
  await require('esbuild').build({ entryPoints: [path.join(repository, 'crabot-desktop/src/installer-main.ts')], outfile: path.join(appDir, 'dist/installer-main.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'original-fs'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" }, logLevel: 'silent' })
  await fs.writeFile(path.join(appDir, 'dist/desktop-release.json'), JSON.stringify(selection) + '\n')
  await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'crabot-removal-frame-fixture', type: 'module', version: '1.2.3', main: 'dist/main.cjs', dependencies: { '@electron/asar': '3.4.1' } }))
  const parser = path.join(appDir, 'node_modules/@electron/asar'); await fs.mkdir(parser, { recursive: true })
  await require('esbuild').build({ entryPoints: [require.resolve('@electron/asar')], outfile: path.join(parser, 'index.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['original-fs'], logLevel: 'silent' })
  await fs.writeFile(path.join(parser, 'package.json'), '{"name":"@electron/asar","version":"3.4.1","main":"index.cjs"}')
  const { build, Platform, Arch } = require('electron-builder')
  const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
  let gui
  await build({ projectDir: root, publish: 'never', targets: Platform.current().createTarget('dir', Arch[process.arch]), config: {
    appId: 'com.crabot.removal-frame-fixture', productName: 'Crabot', electronVersion: '44.9.0', directories: { app: appDir, output: path.join(root, 'unpacked') },
    electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'), files: ['dist/**/*', 'package.json'], asar: true,
    asarUnpack: ['dist/bootstrap/**/*.node'], npmRebuild: false, publish: null,
    electronFuses: { runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: process.platform !== 'linux', onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false },
    mac: { minimumSystemVersion: '14.0.0', identity: '-', hardenedRuntime: false, notarize: false }, win: { executableName: 'Crabot' }, linux: { executableName: 'crabot-desktop' },
    afterPack: async context => {
      gui = context.appOutDir
      const resources = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
      await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(selection) + '\n')
      if (linuxSource) {
        await fs.copyFile(process.env.CRABOT_GTK_ACTOR, path.join(resources, 'crabot-maintenance'))
        await fs.copyFile(path.join(path.dirname(process.env.CRABOT_GTK_FRONTEND), 'crabot-sandbox-helper'), path.join(resources, 'crabot-sandbox-helper'))
        const backend = path.join(resources, 'crabot-maintenance-backend'); await buildUbuntuMaintenanceBackend(backend)
        const main = path.join(backend, 'main.mjs'), source = await fs.readFile(main, 'utf8')
        const operationFile = path.join(backend, 'operation.mjs'), operationSource = await fs.readFile(operationFile, 'utf8')
        assert.ok(operationSource.includes('failure = error;'))
        await fs.writeFile(operationFile, "import fixtureFs from 'node:fs';\n" + operationSource.replace('failure = error;',
          "failure = error;fixtureFs.writeFileSync(process.env.CRABOT_NODE_REMOVAL_TEST_STAGE,JSON.stringify({step,code:error?.code,stage:error?.stage,message:String(error?.message).slice(0,512)})+'\\n');"))
        const referencesFile = path.join(backend, 'bootstrap/scripts/lib/desktop-removal-delete.mjs'), referencesSource = await fs.readFile(referencesFile, 'utf8')
        const marker = '  // Keep the raw observation, including every unknown and its fixed OS reason.'
        assert.ok(referencesSource.includes(marker))
        await fs.writeFile(referencesFile, referencesSource.replace(marker,
          `  const fixtureRoots=[path.join(installRoot,'releases',proof.source_selection.core_id),path.join(installRoot,'app/releases',proof.source_selection.gui_id),path.join(installRoot,'bin')];
  const fixtureRelated=value=>files.includes(value)||fixtureRoots.some(root=>value===root||value.startsWith(root+path.sep));
  const fixtureLinks=pid=>{try{return {cwd:physical.readlinkSync('/proc/'+pid+'/cwd'),fds:physical.readdirSync('/proc/'+pid+'/fd').slice(0,512).flatMap(fd=>{try{const target=physical.readlinkSync('/proc/'+pid+'/fd/'+fd);return fixtureRelated(target)?[{fd,target}]:[]}catch{return []}}).slice(0,8),maps:physical.readFileSync('/proc/'+pid+'/maps','utf8').split('\\n').filter(line=>fixtureRoots.some(root=>line.includes(root))).slice(0,8)}}catch(error){return {code:error.code}}};
  physical.writeFileSync(process.env.CRABOT_NODE_REMOVAL_TEST_STAGE+'.references',JSON.stringify({stage,complete:observation.complete,incomplete:observation.incomplete,holders:observation.processes.slice(0,8).map(holder=>({...holder,references:fixtureLinks(holder.pid)})),unknown:observation.unknown_details?.slice(0,8)})+'\\n');\n`+marker))
        const prefix = `import fixtureChild from 'node:child_process';import{syncBuiltinESMExports as fixtureSync}from'node:module';
          if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Disposable CI only');
          const fixtureSpawn=fixtureChild.spawn;fixtureChild.spawn=(command,args,options)=>command==='/usr/bin/pkexec'?fixtureSpawn('/usr/bin/sudo',['-n','/usr/bin/env','PKEXEC_UID='+process.getuid(),...args],options):fixtureSpawn(command,args,options);fixtureSync();\n`
        const finished = `const result=await runUbuntuRemovalHost(request);fs.writeFileSync(process.env.CRABOT_NODE_REMOVAL_TEST_RESULT,JSON.stringify({accepted:result==='completed',published:true,retained:true,cancelled:false,cancelRejected:false,sourceExited:result==='completed',sourceExitRejected:false,stopRejected:false,cancellationReplyLost:false,lost:false,proofRetained:true,programsRemoved:result==='completed',completionVerified:result==='completed',controlledResourceObservation:false,removalRetried:false,actual_source:true,actual_node_entry:true,polkit_transport_fixture:true})+'\\n')`
        await fs.writeFile(main, prefix + source.replace('await runUbuntuRemovalHost(request)', finished).replace('} catch (error) {', `} catch (error) {fs.writeFileSync(process.env.CRABOT_NODE_REMOVAL_TEST_RESULT,JSON.stringify({accepted:false,code:error?.code,message:String(error?.message).slice(0,512)})+'\\n');`))
      }

    },
  } })
  const executable = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : process.platform === 'linux' ? 'crabot-desktop' : 'Crabot.exe')
  const { getCurrentFuseWire, FuseV1Options } = builder('@electron/fuses'), fuses = await getCurrentFuseWire(executable)
  for (const key of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments]) assert.equal(fuses[key], 48)
  assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], 49)
  assert.equal(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], linuxSource ? 48 : 49)
  await fs.cp(gui, path.join(payload, 'gui'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await sealDesktopPayload(payload)
}, 120000)
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
for (const scenario of ['publish-source-remove-public-entry', 'publish-source-remove-public-core-missing', 'publish-source-remove-windows-entry', 'valid', 'node-parent', 'unexpected-source-args', 'changed-copy', 'other-installation', 'publish-close', 'publish-cancel', 'publish-module', 'publish-damaged', 'publish-lost-reply', 'publish-replaced-record', 'publish-live', 'publish-cancel-lost', 'publish-stop', 'publish-stop-wrong-root', 'publish-stop-lost', 'publish-stop-retry', 'publish-stop-lost-retry', 'publish-inherited-cwd', 'publish-source-verifier', 'publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'publish-source-ignore', 'publish-source-disconnect', 'resume-valid', 'resume-core-missing', 'resume-wrong-operation', 'resume-changed-copy', 'resume-source-changed', 'resume-lease-cancel', 'resume-lease-stopping', 'resume-lease-removing', 'resume-lease-completed', 'resume-lease-core-missing', 'resume-lease-wrong-operation', 'resume-lease-busy', 'resume-lease-source-exit', 'publish-source-remove', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main', 'publish-source-remove-operation', 'publish-source-remove-cancel-retry', 'publish-source-remove-mac-login', 'publish-source-remove-complete', 'publish-source-remove-windows-uninstall', 'publish-source-remove-retry', 'resume-lease-source-remove', 'publish-source-remove-retry-delayed']) test('actual protected initial removal frame: ' + scenario, { skip: !supported || process.platform === 'linux' && scenario !== 'publish-source-remove-source' || ['publish-source-remove-mac-login', 'publish-source-remove-operation', 'publish-source-remove-main'].includes(scenario) && process.platform !== 'darwin' || ['publish-source-remove-windows-uninstall', 'publish-source-remove-windows-entry'].includes(scenario) && process.platform !== 'win32', timeout: scenario.includes('source-remove') ? 180000 : 60000 }, async t => {
  const publicEntry = ['publish-source-remove-public-entry', 'publish-source-remove-public-core-missing', 'publish-source-remove-windows-entry'].includes(scenario)
  let mode = scenario
  if (publicEntry) mode = 'publish-source-remove-source'
  else if (scenario.endsWith('-delayed')) mode = scenario.slice(0, -8)
  const area = await fs.mkdtemp(path.join(root, 'case-'))
  const cancelled = ['publish-cancel', 'publish-cancel-lost', 'publish-stop', 'publish-stop-retry', 'publish-stop-lost-retry', 'publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'publish-source-verifier', 'resume-lease-cancel'].includes(mode)
  if (mode === 'publish-source-remove-complete') {
    const api = await import('../../scripts/lib/desktop-removal-job.mjs')
    assert.equal(typeof api.finishDesktopRemoval, 'function', 'Removal finalization is missing')
  }
  if (mode === 'publish-source-remove-mac-login') {
    const api = await import('../dist/installation-removal.js')
    assert.equal(typeof api.removeMacLoginStartupEntry, 'function', 'Mac same-job login cleanup is missing')
  }
  const sourceExitMode = ['publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'resume-lease-source-exit', 'publish-source-remove', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main', 'publish-source-remove-operation', 'publish-source-remove-cancel-retry', 'publish-source-remove-mac-login', 'publish-source-remove-complete', 'publish-source-remove-windows-uninstall', 'publish-source-remove-retry', 'resume-lease-source-remove'].includes(mode)
  const existingPhase = ({ 'resume-lease-stopping': 'stopping', 'resume-lease-removing': 'removing', 'resume-lease-completed': 'completed', 'resume-lease-source-exit': 'removing', 'resume-lease-source-remove': 'removing' })[mode] || 'preparing'
  const preparedInstallation = await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'installation') })
  if (linuxSource && (await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '')).trim() === '1') {
    await promisify(execFile)('/usr/bin/sudo', ['-n', '/usr/bin/env', 'PKEXEC_UID=' + process.getuid(), path.join(path.dirname(process.env.CRABOT_GTK_FRONTEND), 'crabot-sandbox-helper'), '--register', preparedInstallation.installRoot], { timeout: 30000, maxBuffer: 65536 })
  }
  const own = await commitDesktopInstallation(preparedInstallation)
  let finite, finiteExited, finiteOutput = ''
  if (mode.startsWith('publish-stop')) {
    const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening')
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
    finite = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/lib/__tests__/fixtures/managed-core.mjs', import.meta.url))], {
      env: { ...process.env, TEST_CORE_ROOT: own.coreRoot, TEST_DATA_DIR: own.dataDir, TEST_PORT: String(port), TEST_MARKER: path.join(area, 'stopped'), TEST_READY: path.join(area, 'ready') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    finiteExited = once(finite, 'exit'); const owner = identity.inspectProcess(finite.pid)
    for (const stream of [finite.stdout, finite.stderr]) stream.on('data', bytes => { finiteOutput = (finiteOutput + bytes.toString()).slice(-4000) })
    t.after(async () => {
      const record = readInstanceRuntime(own.dataDir)
      for (const process of [record?.mm, owner]) if (process && identity.sameProcess(process, identity.inspectProcess(process.pid))) globalThis.process.kill(process.pid, 'SIGKILL')
      await finiteExited
    })
    const deadline = Date.now() + 10000
    while (!(await fs.lstat(path.join(area, 'ready')).catch(() => null)) || !readInstanceRuntime(own.dataDir)?.mm) {
      if (finite.exitCode !== null || finite.signalCode !== null || Date.now() > deadline) throw new Error('Finite fixture failed: ' + finiteOutput)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  if (mode === 'publish-stop-wrong-root') {
    const record = readInstanceRuntime(own.dataDir)
    await fs.writeFile(path.join(own.dataDir, 'instance-runtime.json'), JSON.stringify({ ...record, install_root: area }) + '\n')
  }
  const operationId = randomUUID(), cfg = { root: own.root, operationId, mode, publicEntry, resultFile: path.join(area, 'host-result.json'), stageFile: path.join(area, 'host-stage.json'), removalPinDelayMs: scenario.endsWith('-delayed') ? 3000 : 0 }
  if (mode === 'other-installation') cfg.inspectRoot = (await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'other') }))).root
  await fs.writeFile(path.join(own.dataDir, 'preserved-user-file'), 'user bytes')
  if (publicEntry && scenario !== 'publish-source-remove-windows-entry') {
    const { captureDesktopRemovalProof } = await import('../../scripts/lib/desktop-removal-proof.mjs')
    const { privateJson } = await import('../../scripts/lib/desktop-preparation-files.mjs')
    const proof = await captureDesktopRemovalProof(own.root, operationId), job = path.join(own.root, 'app/removals', operationId)
    await fs.mkdir(job, { recursive: true, mode: 0o700 }); await fs.chmod(path.dirname(job), 0o700)
    await privateJson(path.join(job, 'proof.json'), proof)
    await privateJson(path.join(own.root, '.desktop-removal.json'), { schema_version: 1, installation_id: own.record.installation_id,
      operation_id: operationId, source_selection: own.selection, phase: 'preparing',
      proof_sha256: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(proof) + '\n').digest('hex') })
  }
  if (scenario === 'publish-source-remove-public-core-missing') await fs.rm(own.coreRoot, { recursive: true })
  const config = path.join(area, 'control.json'); await fs.writeFile(config, JSON.stringify(cfg))
  const env = { ...process.env, CRABOT_REMOVAL_FRAME_CONFIG: config }
  if (['publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main'].includes(mode)) {
    env.HOME = path.join(own.dataDir, 'finite-user-home')
    await fs.mkdir(env.HOME, { mode: 0o700 })
    env.USERPROFILE = env.HOME; env.APPDATA = path.join(env.HOME, 'Roaming'); env.LOCALAPPDATA = path.join(env.HOME, 'Local')
    env.XDG_CONFIG_HOME = path.join(env.HOME, '.config')
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[key]
  const args = mode === 'publish-source-remove-windows-uninstall' || scenario === 'publish-source-remove-windows-entry' ? ['--uninstall'] : ['--background', ...(mode === 'unexpected-source-args' ? ['--unexpected-maintenance-source'] : [])]
  const direct = mode === 'node-parent' ? await prepareDesktopRemovalGui({ installRoot: own.root, operationId }) : undefined
  t.after(async () => { if (direct) await fs.rm(direct.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
  const child = spawn(direct?.executable || own.executable, direct ? ['--fixture-removal-host'] : args, { env, cwd: direct?.directory ?? (sourceExitMode ? own.guiRoot : undefined), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }), exited = once(child, 'exit')
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes.toString()).slice(-8000) })
  const processIdentity = identity.inspectProcess(child.pid)
  t.after(() => { if (child.exitCode === null && child.signalCode === null && identity.sameProcess(processIdentity, identity.inspectProcess(child.pid))) child.kill('SIGKILL') })
  let result = await Promise.race([once(child, 'message').then(([result]) => result), exited.then(([code, signal]) => { throw new Error('Source exited: ' + code + ':' + signal + '\n' + output) })])
  const [code] = await exited; assert.equal(code, 0, JSON.stringify(result) + '\n' + output)
  if (sourceExitMode) {
    assert.equal(result.handoff, true, JSON.stringify(result))
    const host = result.host, directory = result.directory
    if (linuxSource) assert.equal(result.source_progress_windows, 1)
    const exitState = () => probeKnownProcessExit([host]).state
    t.after(async () => {
      if (identity.sameProcess(host, identity.inspectProcess(host.pid))) globalThis.process.kill(host.pid, 'SIGKILL')
      const deadline = Date.now() + 5000
      while (exitState() === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      if (exitState() !== 'stopped') throw new Error('Known fixture host exit remains unverified; private copy retained')
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    })
    // Observe the complete bounded actor result, including repeated full GUI
    // verification, without changing any product deadline.
    const waitingSince = Date.now(), deadline = waitingSince + (mode.includes('source-remove') ? 130000 : 20000)
    while (!(await fs.lstat(cfg.resultFile).catch(() => null)) || exitState() !== 'stopped') {
      if (Date.now() > deadline) throw new Error('Independent host did not finish after actual source exit: ' + JSON.stringify({
        last_stage: await fs.readFile(cfg.stageFile, 'utf8').then(JSON.parse).catch(() => null), host_exit_state: exitState(), result: await fs.readFile(cfg.resultFile, 'utf8').then(JSON.parse).catch(() => null),
      }))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    result = JSON.parse(await fs.readFile(cfg.resultFile, 'utf8'))
    if (linuxSource) result.diagnostic = { failure: await fs.readFile(cfg.stageFile, 'utf8').catch(() => null), references: await fs.readFile(cfg.stageFile + '.references', 'utf8').catch(() => null) }
    if (mode.includes('source-remove')) console.log('CRABOT_REMOVAL_HOST_TIMING ' + JSON.stringify({ scenario, post_source_exit_ms: Date.now() - waitingSince, controlled_pin_delay_ms: cfg.removalPinDelayMs, pin_reads: result.removalPinReads, removal_elapsed_ms: result.removalElapsedMs }))
    if (scenario.endsWith('-delayed')) { assert.ok(result.removalPinReads >= 8, JSON.stringify(result)); assert.ok(result.removalElapsedMs > 20000, JSON.stringify(result)) }
  }
  if (mode === 'resume-source-remove-main') {
    assert.equal(result.accepted, true, JSON.stringify(result)); assert.equal(result.core_initially_missing, true)
    assert.equal((await import('../../scripts/lib/desktop-removal-record.cjs')).default.readDesktopRemoval(own.root).phase, 'completed')
  } else if (mode.startsWith('resume-')) {
    assert.equal(result.accepted, ['resume-valid', 'resume-core-missing', 'resume-lease-cancel', 'resume-lease-stopping', 'resume-lease-removing', 'resume-lease-completed', 'resume-lease-core-missing', 'resume-lease-source-exit', 'resume-lease-source-remove'].includes(mode), JSON.stringify(result))
    if (result.accepted) {
      assert.equal(result.resumed, true); assert.equal(result.record.operation_id, operationId); assert.equal(result.record.phase, existingPhase)
      if (mode === 'resume-lease-source-exit' || mode.includes('source-remove')) assert.equal(result.sourceExited, true)
      assert.equal(result.frame.source_gui.pid, child.pid); assert.deepEqual(result.record.source_selection, own.selection)
    } else if (mode === 'resume-lease-busy') assert.match(result.message, /another crabot CLI operation is in progress/)
    else assert.equal(result.code, 'CRABOT_DESKTOP_REMOVAL', JSON.stringify(result))
    const removal = (await import('../../scripts/lib/desktop-removal-record.cjs')).default.readDesktopRemoval(own.root)
    if (mode === 'resume-lease-cancel') { assert.equal(removal, null); assert.equal(result.lease_cancelled, true) }
    else {
      assert.equal(removal.operation_id, operationId)
      const phase = mode === 'resume-lease-core-missing' ? 'stopping' : existingPhase
      assert.equal(removal.phase, phase)
      if (['resume-lease-removing', 'resume-lease-completed', 'resume-lease-core-missing'].includes(mode)) assert.equal(result.lease_cancel_rejected, true)
    }
    if (mode.startsWith('resume-lease-') && result.accepted) assert.equal(result.phase_after_stop, existingPhase === 'preparing' ? 'stopping' : existingPhase)
  } else if (mode === 'publish-inherited-cwd') {
    assert.equal(result.accepted, false); assert.equal(result.code, 'CRABOT_DESKTOP_REMOVAL')
  } else if (mode.startsWith('publish-')) {
    assert.equal(result.accepted, true, JSON.stringify(result)); assert.equal(result.published, true)
    assert.equal(result.cancelled, cancelled, JSON.stringify(result)); assert.equal(result.retained, !cancelled)
    assert.equal(result.cancelRejected, ['publish-module', 'publish-damaged', 'publish-replaced-record', 'publish-live', 'publish-stop-wrong-root', 'publish-stop-lost'].includes(mode), JSON.stringify(result))
    assert.equal(result.sourceExited, ['publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'publish-source-remove', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main', 'publish-source-remove-operation', 'publish-source-remove-cancel-retry', 'publish-source-remove-mac-login', 'publish-source-remove-complete', 'publish-source-remove-windows-uninstall', 'publish-source-remove-retry'].includes(mode)); assert.equal(result.sourceExitRejected, ['publish-source-ignore', 'publish-source-disconnect', 'publish-source-retry', 'publish-source-late-exit'].includes(mode))
    assert.equal(result.stopRejected, ['publish-stop-wrong-root', 'publish-stop-lost', 'publish-stop-retry', 'publish-stop-lost-retry'].includes(mode))
    if (mode === 'publish-stop-lost') assert.equal(result.phase, 'stopping')
    assert.equal(result.cancellationReplyLost, mode === 'publish-cancel-lost'); assert.equal(result.lost, mode === 'publish-lost-reply'); assert.equal(result.proofRetained, true)
  } else if (mode === 'valid') {
    assert.equal(result.accepted, true, JSON.stringify(result)); assert.equal(result.frame.operation_id, operationId)
    assert.equal(result.frame.installation_id, own.record.installation_id); assert.equal(result.frame.source_gui.pid, child.pid)
    assert.notEqual(result.frame.host_gui.pid, child.pid); assert.deepEqual(result.frame.source_selection, own.selection)
  } else {
    assert.equal(result.accepted, false, JSON.stringify(result)); assert.equal(result.code, 'CRABOT_DESKTOP_REMOVAL', JSON.stringify(result))
    assert.equal(result.stage, mode === 'changed-copy' ? 'private-programs' : 'source-peer', JSON.stringify(result))
  }
  if (['publish-source-remove-complete', 'publish-source-remove-operation', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main'].includes(mode)) assert.equal(result.completionVerified, true)
  if (!linuxSource && ['publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main'].includes(mode)) { assert.equal(result.actual_main, true); assert.equal(result.actual_progress_windows, 1); assert.equal(result.os_api_mocked, true); assert.equal(result.login_writes, process.platform === 'darwin' ? 1 : 0); assert.equal(result.registration_calls, process.platform === 'darwin' ? 1 : 0); assert.equal(result.message, '应用已卸载，数据已保留。') }
  if (mode === 'publish-cancel') assert.equal(result.private_copy_removed, true)
  if (scenario === 'publish-source-remove-public-core-missing') assert.equal(result.core_initially_missing, true)
  if (mode === 'publish-source-remove-source') { assert.equal(result.actual_source, true); if (!linuxSource) assert.deepEqual(result.dialog_codes, [], JSON.stringify(result)); else { assert.equal(result.actual_node_entry, true); assert.equal(result.polkit_transport_fixture, true) } }
  if (mode === 'publish-source-remove-windows-uninstall') assert.equal(result.windowsUninstallEntryRemoved, true)
  if (mode === 'publish-source-remove-mac-login') { assert.equal(result.macLoginCleaned, true); assert.equal(result.macLoginApiMocked, true) }
  if (mode.includes('source-remove')) { assert.equal(result.programsRemoved, true); assert.equal(result.controlledResourceObservation, !linuxSource); assert.equal(result.removalRetried, mode === 'publish-source-remove-retry'); assert.equal((await import('../../scripts/lib/desktop-removal-record.cjs')).default.readDesktopRemoval(own.root).phase, ['publish-source-remove-complete', 'publish-source-remove-operation', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main'].includes(mode) ? 'completed' : 'removing'); await assert.rejects(fs.lstat(own.executable), { code: 'ENOENT' }) }
  if ((!mode.startsWith('resume-') && !mode.startsWith('publish-')) || cancelled || mode === 'publish-inherited-cwd') await assert.rejects(fs.lstat(path.join(own.root, '.desktop-removal.json')), { code: 'ENOENT' })
  else assert.equal((await fs.lstat(path.join(own.root, '.desktop-removal.json'))).isFile(), true)
  assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved-user-file'), 'utf8'), 'user bytes')
  if (finite && !['publish-stop', 'publish-stop-retry', 'publish-stop-lost-retry'].includes(mode)) {
    assert.equal(finite.exitCode, null); assert.equal(finite.signalCode, null); assert.equal(inspectInstance(own.dataDir).state, 'running')
    await assert.rejects(fs.lstat(path.join(area, 'stopped')), { code: 'ENOENT' }); return
  }
  if (finite) {
    assert.equal((await finiteExited)[0], 0, finiteOutput); assert.equal(await fs.readFile(path.join(area, 'stopped'), 'utf8'), 'graceful')
    assert.equal(finiteOutput.split('FIXTURE_SHUTDOWN ').length - 1, 1); assert.equal(readInstanceRuntime(own.dataDir), null)
    assert.equal(inspectInstance(own.dataDir).state, 'stopped'); assert.equal(result.stopApplied, true)
  }
  await fs.rm(area, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

let installerImage
async function removalInstaller() {
  return installerImage ||= (async () => {
    const { build, Platform, Arch } = require('electron-builder')
    let resources
    await build({ projectDir: root, publish: 'never', targets: Platform.current().createTarget('dir', Arch[process.arch]), config: {
      appId: 'com.crabot.installer', productName: 'Crabot Installer', electronVersion: '44.9.0',
      directories: { app: path.join(root, 'app'), output: path.join(root, 'installer') },
      electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'), files: ['dist/**/*', 'package.json'], asar: true,
      asarUnpack: ['dist/bootstrap/**/*.node'], npmRebuild: false, publish: null,
      electronFuses: { runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false },
      mac: { minimumSystemVersion: '14.0.0', identity: '-', hardenedRuntime: false, notarize: false, signIgnore: ['/Resources/offline/'] },
      win: { executableName: 'CrabotInstaller' },
      afterPack: async context => {
        resources = path.join(context.appOutDir, process.platform === 'darwin' ? 'Crabot Installer.app/Contents/Resources' : 'resources')
        await fs.cp(payload, path.join(resources, 'offline'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
      },
    } })
    return process.platform === 'darwin' ? path.resolve(resources, '../MacOS/Crabot Installer') : path.resolve(resources, '../CrabotInstaller.exe')
  })()
}
for (const mode of ['installer-valid', 'installer-wrong-operation', 'installer-changed-copy', 'installer-source-args', 'installer-source', 'installer-ui']) {
  test('actual offline installer continues a removal without original GUI or Core: ' + mode, { skip: !['darwin', 'win32'].includes(process.platform), timeout: 120000 }, async t => {
    const area = await fs.mkdtemp(path.join(root, 'installer-case-'))
    const own = await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'installed') }))
    await fs.writeFile(path.join(own.dataDir, 'preserved-user-file'), 'user bytes')
    const config = path.join(area, 'control.json'), operationId = randomUUID()
    await fs.writeFile(config, JSON.stringify({ mode, root: own.root, operationId, resultFile: path.join(area, 'host-result.json') }))
    const home = path.join(area, 'private-home'); await fs.mkdir(home, { mode: 0o700 })
    const env = { ...process.env, CRABOT_REMOVAL_FRAME_CONFIG: config, HOME: home, USERPROFILE: home,
      APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), XDG_CONFIG_HOME: path.join(home, '.config') }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[key]
    const child = spawn(await removalInstaller(), mode === 'installer-source-args' ? ['--unexpected'] : [], {
      env, cwd: area, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const stopped = once(child, 'exit'), peer = identity.inspectProcess(child.pid)
    t.after(() => { if (child.exitCode === null && child.signalCode === null && identity.sameProcess(peer, identity.inspectProcess(child.pid))) child.kill('SIGKILL') })
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output = (output + value.toString()).slice(-4000) })
    const [result] = await Promise.race([once(child, 'message'), stopped.then(([code]) => { throw Error('Installer source exited: ' + code + '\n' + output) })])
    const [code] = await stopped
    assert.equal(code, 0, output); assert.equal(result.accepted, ['installer-valid', 'installer-source', 'installer-ui'].includes(mode), JSON.stringify(result))
    const record = (await import('../../scripts/lib/desktop-removal-record.cjs')).default.readDesktopRemoval(own.root)
    assert.equal(record.operation_id, operationId); assert.equal(record.phase, ['installer-source', 'installer-ui'].includes(mode) ? 'completed' : 'removing')
    assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved-user-file'), 'utf8'), 'user bytes')
    await assert.rejects(fs.lstat(own.coreRoot), { code: 'ENOENT' }); await assert.rejects(fs.lstat(own.guiRoot), { code: 'ENOENT' })
    if (result.accepted) {
      assert.equal(result.original_proof_preserved, true); assert.equal(result.parent_remained_alive, true)
      assert.equal(result.programsRemoved, true); assert.equal(result.loginWrites, process.platform === 'darwin' ? 1 : 0)
    } else assert.ok(['CRABOT_DESKTOP_REMOVAL', 'CRABOT_CORE_INTEGRITY'].includes(result.code), JSON.stringify(result))
    // Both finite GUI processes are reaped; this exact returned copy was never
    // persisted as a restart entry and contains no user data.
    if (['installer-source', 'installer-ui'].includes(mode)) assert.equal(result.source_completed_cleanup, true)
    else await fs.rm(result.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
}
