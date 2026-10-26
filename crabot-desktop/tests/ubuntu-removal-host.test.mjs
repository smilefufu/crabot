import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { acquireExistingCliLock, releaseCliLock } from '../../scripts/lib/cli-lock.mjs'
import identity from '../../scripts/lib/process-identity.cjs'
import { probeKnownProcessExit } from '../../scripts/lib/known-process-exit.cjs'
import { writeCoreRelease, verifyCoreRelease } from '../../scripts/lib/core-release.mjs'
import { sealDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../../scripts/lib/desktop-payload.mjs'
import { buildUbuntuMaintenanceBackend } from '../../scripts/desktop/ubuntu-maintenance-backend.mjs'
import { desktopMaintenanceNodeFiles } from '../../scripts/lib/desktop-maintenance-bootstrap.mjs'
const linux = process.platform === 'linux', require = createRequire(new URL('../package.json', import.meta.url))
let root, payload
before(async () => {
  if (!linux) return
  root = await fs.realpath(await fs.mkdtemp(path.join(homedir(), '.crabot-node-removal-source-')))
  payload = path.join(root, 'payload')
  const core = path.join(payload, 'core'), gui = path.join(payload, 'gui'), resources = path.join(gui, 'resources')
  await fs.mkdir(path.join(core, '.product-runtime/node/bin'), { recursive: true }); await fs.mkdir(path.join(core, 'bin'))
  await fs.copyFile(process.execPath, path.join(core, '.product-runtime/node/bin/node'))
  // Inert ELF bytes provide only the original browser-policy inventory. These
  // role tests never execute a browser or claim namespace/GUI acceptance.
  const browser = path.join(core, '.scrapling-runtime-fixture-0123456789abcdef-12345678/browsers/chromium-1234/chrome-linux64/chrome')
  await fs.mkdir(path.dirname(browser), { recursive: true })
  await fs.copyFile(path.join(path.dirname(process.env.CRABOT_GTK_FRONTEND), 'crabot-sandbox-helper'), browser)
  await fs.writeFile(path.join(core, 'package.json'), '{"version":"1.2.3","type":"module"}')
  await fs.writeFile(path.join(core, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version: '1.2.3', versions: { node: process.versions.node } }))
  await fs.writeFile(path.join(core, 'bin/crabot'), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
  await writeCoreRelease(core, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  await fs.writeFile(path.join(core, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }))
  const release = await verifyCoreRelease(core), selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: release.inventory_sha256 }
  await fs.mkdir(resources, { recursive: true })
  await buildUbuntuMaintenanceBackend(path.join(resources, 'crabot-maintenance-backend'))
  // A finite Node image stands in only for source OS identity; no Electron/GUI acceptance is claimed.
  await fs.copyFile(process.execPath, path.join(gui, 'crabot-desktop'))
  await fs.copyFile(process.env.CRABOT_GTK_FRONTEND, path.join(resources, 'crabot-maintenance'))
  await fs.copyFile(path.join(path.dirname(process.env.CRABOT_GTK_FRONTEND), 'crabot-sandbox-helper'), path.join(resources, 'crabot-sandbox-helper'))
  const native = path.join(resources, 'app.asar.unpacked/dist/bootstrap/crabot-native/build/Release/crabot-native.node')
  await fs.mkdir(path.dirname(native), { recursive: true })
  await fs.copyFile(fileURLToPath(new URL('../../crabot-native/build/Release/crabot-native.node', import.meta.url)), native)
  const app = path.join(root, 'app'); await fs.mkdir(path.join(app, 'dist'), { recursive: true })
  await fs.writeFile(path.join(app, 'dist/desktop-release.json'), JSON.stringify(selection) + '\n')
  await require('@electron/asar').createPackage(app, path.join(resources, 'app.asar'))
  await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(selection) + '\n')
  await sealDesktopPayload(payload)
}, 60000)
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }) })
test('standalone maintenance preparation rejects other platforms before accessing an installation', { skip: linux }, async () => {
  const { runUbuntuRemovalHost } = await import('../dist/ubuntu-removal-host.js')
  await assert.rejects(runUbuntuRemovalHost({ installRoot: '/never-accessed', operationId: randomUUID(), existing: false }), { code: 'CRABOT_DESKTOP_REMOVAL' })
  const { prepareDesktopRemovalNode, prepareExistingDesktopRemovalNode } = await import('../../scripts/lib/desktop-removal-host.mjs')
  assert.equal(typeof prepareExistingDesktopRemovalNode, 'function')
  await assert.rejects(prepareExistingDesktopRemovalNode({ installRoot: '/never-accessed', operationId: randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL' })
  const { resumeDesktopRemovalNode } = await import('../../scripts/lib/desktop-removal-job.mjs')
  assert.equal(typeof resumeDesktopRemovalNode, 'function')
  await assert.rejects(resumeDesktopRemovalNode({ installRoot: '/never-accessed', operationId: randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL' })
  await assert.rejects(prepareDesktopRemovalNode({ installRoot: '/never-accessed', operationId: randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL' })
  const { beginInitialDesktopRemovalNode } = await import('../../scripts/lib/desktop-removal-job.mjs')
  await assert.rejects(() => beginInitialDesktopRemovalNode({ installRoot: '/never-accessed', operationId: randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL' })
  const { createDesktopRemovalNodeSourceExitVerifier } = await import('../../scripts/lib/desktop-removal-source.mjs')
  assert.equal(await createDesktopRemovalNodeSourceExitVerifier({})({}), false)
})
for (const mode of ['valid', 'cancelled', 'changed-node', 'changed-backend', 'redirected-frontend', 'changed-selection', 'copy-failure', 'space', 'late-copy-change', 'late-cancel', 'changed-sandbox-helper']) test('private Ubuntu Node host preparation: ' + mode, { skip: !linux, timeout: 60000 }, async t => {
  const area = await fs.mkdtemp(path.join(root, 'case-'))
  const own = await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'installation') }))
  await fs.writeFile(path.join(own.dataDir, 'preserved'), 'data and dependencies')
  const options = { installRoot: own.root, operationId: randomUUID() }, source = path.join(own.guiRoot, 'resources/crabot-maintenance-backend/progress.mjs')
  const { prepareDesktopRemovalNode } = await import('../../scripts/lib/desktop-removal-host.mjs')
  if (mode === 'cancelled') options.signal = AbortSignal.abort()
  if (mode === 'changed-node') await fs.appendFile(path.join(own.coreRoot, '.product-runtime/node/bin/node'), 'changed')
  if (mode === 'changed-backend') await fs.appendFile(source, 'changed')
  if (mode === 'changed-sandbox-helper') await fs.appendFile(path.join(own.guiRoot, 'resources', 'crabot-sandbox-helper'), 'changed')
  if (mode === 'redirected-frontend') { const file = path.join(own.guiRoot, 'resources/crabot-maintenance'); await fs.rename(file, file + '-original'); await fs.symlink(file + '-original', file) }
  let copyDirectory
  options.progress = stage => {
    if (stage === 'prepared' && mode === 'late-copy-change') return fs.appendFile(path.join(copyDirectory, 'node'), 'changed')
    if (stage === 'prepared' && mode === 'late-cancel') lateAbort.abort()
    if (stage === 'copying' && mode === 'changed-selection') {
      // A source change between capture and completion must invalidate the copy.
      return fs.appendFile(path.join(own.root, 'current-release.json'), ' ')
    }
  }
  if (mode === 'space') t.mock.method(fs, 'statfs', async () => ({ bavail: 0n, bsize: 1n }))
  const lateAbort = new AbortController()
  if (mode === 'late-cancel') options.signal = lateAbort.signal
  if (mode === 'copy-failure' || mode === 'late-copy-change' || mode === 'late-cancel') {
    const open = fs.open
    t.mock.method(fs, 'open', async (file, ...rest) => {
      if (String(file).includes('crabot-removal-host-') && String(file).endsWith('/node')) copyDirectory = path.dirname(file)
      if (mode === 'copy-failure' && String(file).includes('crabot-removal-host-') && String(file).endsWith('/backend/progress.mjs')) {
        copyDirectory = path.resolve(file, '../..'); throw Object.assign(new Error('finite copy failure'), { code: 'ENOSPC' })
      }
      return open(file, ...rest)
    })
  }
  if (mode === 'valid') {
    const host = await prepareDesktopRemovalNode(options)
    t.after(() => fs.rm(host.directory, { recursive: true, force: true }))
    assert.equal(path.dirname(host.executable), host.directory)
    assert.equal(path.basename(host.executable), 'node')
    assert.equal(host.self_verified, true)
    const names = []
    async function walk(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else names.push(path.relative(host.directory, file).split(path.sep).join('/')) } }
    await walk(host.directory)
    assert.deepEqual(names.sort(), ['node', 'crabot-maintenance', 'crabot-sandbox-helper', ...desktopMaintenanceNodeFiles.map(name => 'backend/' + name)].sort())
    assert.equal(names.some(name => /(^|\/)(data|core|\.product-runtime)(\/|$)/.test(name)), false)
    assert.equal(host.proof.operation_id, options.operationId)
    console.log('CRABOT_PRIVATE_NODE_PREPARATION ' + JSON.stringify({ fixed_resources_only: true, copied_node_executed: true, self_verified: true, business_started: false }))
  } else await assert.rejects(prepareDesktopRemovalNode(options))
  if (copyDirectory) await assert.rejects(fs.lstat(copyDirectory), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved'), 'utf8'), 'data and dependencies')
  for (const name of ['.desktop-removal.json', '.desktop-installing.json']) await assert.rejects(fs.lstat(path.join(own.root, name)), { code: 'ENOENT' })
})


for (const mode of ['node-job-resume', 'node-job-resume-source-exit', 'node-job-full-host', 'node-job-valid', 'node-job-parent-flags', 'node-job-copy-changed', 'node-job-other-installation', 'node-job-source-verifier', 'node-job-source-exit', 'node-job-source-remove', 'node-job-source-platform-cancel']) test('actual private Node initial job role: ' + mode, { skip: !linux || ['node-job-full-host', 'node-job-source-remove', 'node-job-source-platform-cancel'].includes(mode) && process.env.GITHUB_ACTIONS !== 'true', timeout: 60000 }, async t => {
  const area = await fs.mkdtemp(path.join(root, 'node-role-'))
  let sourcePayload = payload
  if (mode === 'node-job-full-host') {
    sourcePayload = path.join(area, 'finite-host-payload'); await fs.cp(payload, sourcePayload, { recursive: true })
    const resources = path.join(sourcePayload, 'gui/resources'), backend = path.join(resources, 'crabot-maintenance-backend')
    const frontend = path.join(resources, 'crabot-maintenance')
    await promisify(execFile)('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-DCRABOT_FULL_REMOVAL_HOST', fileURLToPath(new URL('./fixtures/removal-progress-peer.c', import.meta.url)), '-o', frontend])
    const pinFile = path.join(resources, 'desktop-release.json'), pin = JSON.parse(await fs.readFile(pinFile, 'utf8'))
    pin.gui_id = randomUUID(); await fs.writeFile(pinFile, JSON.stringify(pin) + '\n')
    const app = path.join(area, 'finite-host-app'); await fs.mkdir(path.join(app, 'dist'), { recursive: true })
    await fs.writeFile(path.join(app, 'dist/desktop-release.json'), JSON.stringify(pin) + '\n')
    await fs.unlink(path.join(resources, 'app.asar')); await require('@electron/asar').createPackage(app, path.join(resources, 'app.asar'))
    // This disposable payload instruments only the OS authorization transport.
    // The fixed entry/host, actual copied native helper, job and bytes stay real.
    const main = path.join(backend, 'main.mjs'), text = (await fs.readFile(main, 'utf8')).replace('} catch (error) {', `} catch (error) {fs.writeFileSync(process.env.CRABOT_NODE_REMOVAL_TEST_RESULT,JSON.stringify({accepted:false,code:error?.code,stage:error?.stage,message:String(error?.message).slice(0,512)})+'\\n');`)
    const instrumentation = `import fixtureChild from 'node:child_process';import {syncBuiltinESMExports as fixtureSync} from 'node:module';
      if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Disposable CI only');
      const fixtureSpawn=fixtureChild.spawn;
      fixtureChild.spawn=(command,args,options)=>command==='/usr/bin/pkexec'?fixtureSpawn('/usr/bin/sudo',['-n','/usr/bin/env','PKEXEC_UID='+process.getuid(),...args],options):fixtureSpawn(command,args,options);
      fixtureSync();\n`
    await fs.writeFile(main, instrumentation + text.replace('await runUbuntuRemovalHost(request)', `const result=await runUbuntuRemovalHost(request);fs.writeFileSync(process.env.CRABOT_NODE_REMOVAL_TEST_RESULT,JSON.stringify({accepted:result==='completed',completed:result==='completed',fixed_node_entry:true,frontend_fixture:true,polkit_transport_fixture:true,...(result==='completed'?{}:{last_progress:fs.readFileSync(path.join(directory,'last-progress'),'utf8').slice(0,1024)})})+'\\n')`))
    await fs.unlink(path.join(sourcePayload, 'desktop-payload.json'))
    await sealDesktopPayload(sourcePayload)
  }
  const own = await commitDesktopInstallation(await prepareDesktopInstallation({ payload: sourcePayload, installRoot: path.join(area, 'installation') }))
  await fs.writeFile(path.join(own.dataDir, 'preserved'), 'unchanged user content')
  const cfg = { mode, own, operationId: randomUUID(), resultFile: path.join(area, 'node-result.json') }
  if (mode === 'node-job-other-installation') cfg.otherRoot = (await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'other') }))).root
  const env = { ...process.env, CRABOT_NODE_REMOVAL_FIXTURE: JSON.stringify(cfg) }
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[name]
  const running = promisify(execFile)(own.executable, mode === 'node-job-parent-flags' ? ['--no-warnings'] : [], { cwd: area, env, timeout: 50000, maxBuffer: 8192 })
  running.child.stdin.end(await fs.readFile(new URL('./fixtures/ubuntu-removal-node-parent.cjs', import.meta.url)))
  const { stdout } = await running
  let result = JSON.parse(stdout)
  if (['node-job-resume-source-exit', 'node-job-full-host', 'node-job-source-exit', 'node-job-source-remove', 'node-job-source-platform-cancel'].includes(mode)) {
    assert.equal(result.handoff, true)
    const { directory, host } = result
    const stat = await fs.lstat(directory, { bigint: true })
    t.after(async () => {
      if (identity.sameProcess(host, identity.inspectProcess(host.pid))) identity.terminateKnownProcess(host)
      const deadline = Date.now() + 5000
      while (probeKnownProcessExit([host]).state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      assert.equal(probeKnownProcessExit([host]).state, 'stopped')
      const actual = await fs.lstat(directory, { bigint: true })
      assert.equal(actual.dev, stat.dev); assert.equal(actual.ino, stat.ino)
      await fs.rm(directory, { recursive: true })
    })
    const deadline = Date.now() + 35000
    while (!await fs.lstat(cfg.resultFile).catch(() => null) || probeKnownProcessExit([host]).state !== 'stopped') {
      if (Date.now() >= deadline) throw new Error('Private Node did not complete after actual source exit: ' + JSON.stringify({ result: await fs.readFile(cfg.resultFile, 'utf8').then(JSON.parse).catch(() => null), stage: await fs.readFile(cfg.resultFile + '.stage', 'utf8').then(JSON.parse).catch(() => null), exit: probeKnownProcessExit([host]).state }))
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    result = JSON.parse(await fs.readFile(cfg.resultFile, 'utf8'))
    if (mode === 'node-job-full-host') assert.deepEqual(result, { accepted: true, completed: true, fixed_node_entry: true, frontend_fixture: true, polkit_transport_fixture: true })
    else assert.deepEqual(result, { accepted: true, published: mode === 'node-job-resume-source-exit' ? 'stopping' : 'preparing', stopped: 'stopping', cancelled: mode !== 'node-job-source-remove', ordinary_peer: false, locks_reacquired: true, source_exited: true, ...(mode === 'node-job-source-remove' ? { programs_removed: true, platform_cleanup_attempts: 2, completed: true } : {}), ...(mode === 'node-job-source-platform-cancel' ? { platform_cancelled: true } : {}) })
  } else if (mode === 'node-job-source-verifier') assert.deepEqual(result, { accepted: true, published: 'preparing', stopped: 'stopping', cancelled: true, ordinary_peer: false, locks_reacquired: true,
    source_verifier: { preparing_rejected: true, wrong_operation_rejected: true, verified_after_stop: true, changed_copy_rejected: true } })
  else if (['node-job-valid', 'node-job-resume'].includes(mode)) assert.deepEqual(result, { accepted: true, published: mode === 'node-job-resume' ? 'stopping' : 'preparing', stopped: 'stopping', cancelled: true, ordinary_peer: false, locks_reacquired: true, ...(mode === 'node-job-valid' ? { private_copy_removed: true } : {}) })
  else assert.deepEqual(result, { accepted: false, code: 'CRABOT_DESKTOP_REMOVAL' })
  assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved'), 'utf8'), 'unchanged user content')
  for (const installation of [own.root, cfg.otherRoot].filter(Boolean)) {
    for (const name of ['.desktop-removal.json', '.desktop-installing.json']) {
      if (['node-job-full-host', 'node-job-source-remove'].includes(mode) && name === '.desktop-removal.json') assert.equal(JSON.parse(await fs.readFile(path.join(installation, name), 'utf8')).phase, 'completed')
      else await assert.rejects(fs.lstat(path.join(installation, name)), { code: 'ENOENT' })
    }
    const rootLock = await acquireExistingCliLock(installation, 'verify-node-role-released', 0)
    try {
      const dataLock = await acquireExistingCliLock(path.join(installation, 'data'), 'verify-node-role-released', 0)
      releaseCliLock(dataLock)
    } finally { releaseCliLock(rootLock) }
  }
  if (['node-job-full-host', 'node-job-source-remove'].includes(mode)) await assert.rejects(fs.lstat(own.executable), { code: 'ENOENT' })
  else assert.equal((await fs.stat(own.executable)).isFile(), true)
})

for (const mode of ['preparing', 'stopping', 'removing-partial-core', 'wrong-operation', 'source-changed', 'runtime-changed']) test('existing private Node copy preserves its historical job: ' + mode, { skip: !linux, timeout: 60000 }, async t => {
  const area = await fs.mkdtemp(path.join(root, 'existing-node-')), own = await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'installation') }))
  const operationId = randomUUID(), { captureDesktopRemovalProof } = await import('../../scripts/lib/desktop-removal-proof.mjs')
  const proof = await captureDesktopRemovalProof(own.root, operationId), text = JSON.stringify(proof) + '\n'
  const directory = path.join(own.root, 'app/removals', operationId); await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(directory, 'proof.json'), text, { mode: 0o600 })
  const record = { schema_version: 1, installation_id: own.record.installation_id, operation_id: operationId, source_selection: own.selection,
    phase: mode === 'preparing' ? 'preparing' : mode === 'removing-partial-core' ? 'removing' : 'stopping', proof_sha256: createHash('sha256').update(text).digest('hex') }
  const fence = path.join(own.root, '.desktop-removal.json'), bytes = JSON.stringify(record) + '\n'
  await fs.writeFile(fence, bytes, { mode: 0o600 }); await fs.writeFile(path.join(own.dataDir, 'preserved'), 'historical data')
  if (mode === 'removing-partial-core') await fs.rm(path.join(own.coreRoot, '.scrapling-runtime-fixture-0123456789abcdef-12345678'), { recursive: true })
  if (mode === 'source-changed') await fs.appendFile(path.join(own.guiRoot, 'resources/desktop-release.json'), 'changed')
  if (mode === 'runtime-changed') await fs.appendFile(path.join(own.coreRoot, 'product-runtime.json'), 'changed')
  const { prepareExistingDesktopRemovalNode } = await import('../../scripts/lib/desktop-removal-host.mjs')
  const preparing = prepareExistingDesktopRemovalNode({ installRoot: own.root, operationId: mode === 'wrong-operation' ? randomUUID() : operationId })
  if (['preparing', 'stopping', 'removing-partial-core'].includes(mode)) {
    const prepared = await preparing; t.after(() => fs.rm(prepared.directory, { recursive: true }))
    assert.deepEqual(prepared.record, record); assert.equal(prepared.self_verified, true); assert.deepEqual(prepared.proof, proof)
  } else await assert.rejects(preparing)
  assert.equal(await fs.readFile(fence, 'utf8'), bytes); assert.equal(await fs.readFile(path.join(directory, 'proof.json'), 'utf8'), text)
  assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved'), 'utf8'), 'historical data')
})

for (const mode of ['valid', 'wrong-operation', 'changed-parent', 'changed-helper', 'changed-payload', 'cancelled', 'early-cancel']) {
  test('offline installer Node continues an existing removal with original programs missing: ' + mode,
    { skip: !linux || process.env.GITHUB_ACTIONS !== 'true', timeout: 90000 }, async () => {
      const area = await fs.mkdtemp(path.join(root, 'offline-continuation-')), bundle = path.join(area, 'bundle')
      await fs.mkdir(bundle)
      await fs.cp(payload, path.join(bundle, 'offline'), { recursive: true, verbatimSymlinks: true })
      const installer = path.join(bundle, 'crabot-installer'), helper = path.join(bundle, 'crabot-sandbox-helper')
      await promisify(execFile)('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
        fileURLToPath(new URL('native/ubuntu-installer-parent.c', import.meta.url)), '-o', installer])
      await fs.copyFile(path.join(path.dirname(process.env.CRABOT_GTK_FRONTEND), 'crabot-sandbox-helper'), helper)
      const files = {}
      for (const name of ['crabot-installer', 'crabot-sandbox-helper']) {
        const bytes = await fs.readFile(path.join(bundle, name)); files[name] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      }
      await fs.writeFile(path.join(bundle, 'native-bootstrap.json'), JSON.stringify({ schema_version: 1, platform: 'linux', arch: 'x64',
        build_os: 'ubuntu-24.04', commit: '1'.repeat(40), source_dirty: false, files }))
      const own = await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'installed') }))
      await fs.writeFile(path.join(own.dataDir, 'preserved'), 'data and dependencies')
      const { captureDesktopRemovalProof } = await import('../../scripts/lib/desktop-removal-proof.mjs')
      const { privateJson } = await import('../../scripts/lib/desktop-preparation-files.mjs')
      const operationId = randomUUID(), proof = await captureDesktopRemovalProof(own.root, operationId)
      const proofDirectory = path.join(own.root, 'app/removals', operationId)
      await fs.mkdir(proofDirectory, { recursive: true, mode: 0o700 }); await fs.chmod(path.dirname(proofDirectory), 0o700)
      await privateJson(path.join(proofDirectory, 'proof.json'), proof)
      await privateJson(path.join(own.root, '.desktop-removal.json'), { schema_version: 1, installation_id: own.record.installation_id,
        operation_id: operationId, source_selection: own.selection, phase: 'removing',
        proof_sha256: createHash('sha256').update(JSON.stringify(proof) + '\n').digest('hex') })
      await fs.rm(own.coreRoot, { recursive: true }); await fs.rm(own.guiRoot, { recursive: true })
      if (mode === 'changed-parent') await fs.appendFile(installer, 'changed')
      if (mode === 'changed-helper') {
        await fs.appendFile(helper, 'changed'); const bytes = await fs.readFile(helper)
        const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'native-bootstrap.json'), 'utf8'))
        manifest.files['crabot-sandbox-helper'] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
        await fs.writeFile(path.join(bundle, 'native-bootstrap.json'), JSON.stringify(manifest))
      }
      if (mode === 'changed-payload') await fs.appendFile(path.join(bundle, 'offline/core/cli.mjs'), 'changed')
      const home = path.join(area, 'home'); await fs.mkdir(home, { mode: 0o700 })
      const resultFile = path.join(area, 'result.json'), cfg = path.join(area, 'control.json')
      await fs.writeFile(cfg, JSON.stringify({ bundle, root: own.root, operationId: mode === 'wrong-operation' ? randomUUID() : operationId,
        cancelled: mode === 'cancelled', resultFile }))
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share') }
      for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[name]
      if (mode === 'early-cancel') {
        // The ordinary packager includes the installer library tree, beyond the
        // smaller maintenance bootstrap. Stage the real read-only preconditions
        // here too, rather than fail at a missing import before stdin is read.
        const backendDirectory = path.join(bundle, 'backend/dist')
        await fs.cp(fileURLToPath(new URL('../dist/', import.meta.url)), backendDirectory, { recursive: true })
        await fs.cp(path.join(bundle, 'offline/gui/resources/crabot-maintenance-backend/node_modules'), path.join(bundle, 'backend/node_modules'), { recursive: true })
        for (const name of ['mode.mjs', 'legacy-desktop.mjs', 'legacy-release-identity.mjs', 'legacy-release-files.mjs']) {
          await fs.copyFile(fileURLToPath(new URL('../../scripts/lib/' + name, import.meta.url)), path.join(backendDirectory, 'bootstrap/scripts/lib', name))
        }
        const catalog = path.join(backendDirectory, 'bootstrap/scripts/desktop')
        await fs.mkdir(catalog, { recursive: true })
        await fs.copyFile(fileURLToPath(new URL('../../scripts/desktop/legacy-releases.json', import.meta.url)), path.join(catalog, 'legacy-releases.json'))
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
          'import{pathToFileURL}from"node:url";for(const file of process.argv.slice(1))await import(pathToFileURL(file).href)',
          ...['desktop-payload.mjs', 'mode.mjs', 'legacy-desktop.mjs'].map(name => path.join(backendDirectory, 'bootstrap/scripts/lib', name))],
          { env, cwd: bundle, timeout: 5000, maxBuffer: 65536 })
        const child = spawn(process.execPath, [path.join(backendDirectory, 'ubuntu-installer-backend.js'), own.root], {
          env, cwd: bundle, stdio: ['pipe', 'pipe', 'pipe'],
        })
        const exited = once(child, 'exit'), peer = identity.inspectProcess(child.pid)
        let timedOut = false, output = ''
        child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-8192) })
        child.stderr.resume()
        const timer = setTimeout(() => {
          timedOut = true
          if (child.exitCode === null && child.signalCode === null && identity.sameProcess(peer, identity.inspectProcess(child.pid))) child.kill('SIGKILL')
        }, 5000)
        child.stdin.write('{"action":"cancel"}\n') // Keep stdin open to expose a forgotten pending-choice promise.
        try {
          const [code] = await exited; assert.equal(timedOut, false); assert.equal(code, 2, output)
          assert.deepEqual(JSON.parse(output.trim()), { type: 'failed', code: 'CANCELLED' })
          assert.equal(JSON.parse(await fs.readFile(path.join(own.root, '.desktop-removal.json'), 'utf8')).phase, 'removing')
          assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved'), 'utf8'), 'data and dependencies')
        } finally { clearTimeout(timer); child.stdin.destroy() }
        return
      }
      const executed = await promisify(execFile)(installer, [path.join(bundle, 'offline/core/.product-runtime/node/bin/node'),
        fileURLToPath(new URL('fixtures/ubuntu-installer-removal-actor.mjs', import.meta.url)), cfg], { cwd: bundle, env, timeout: 75000, maxBuffer: 65536 })
      const actual = JSON.parse(await fs.readFile(resultFile, 'utf8'))
      assert.equal(actual.result, mode === 'valid' ? 'completed' : 'rejected', JSON.stringify(actual) + '\n' + executed.stderr)
      assert.equal(actual.authorizations, mode === 'valid' ? 1 : 0)
      assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved'), 'utf8'), 'data and dependencies')
      const record = JSON.parse(await fs.readFile(path.join(own.root, '.desktop-removal.json'), 'utf8'))
      assert.equal(record.phase, mode === 'valid' ? 'completed' : 'removing'); assert.equal(record.operation_id, operationId)
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(proofDirectory, 'proof.json'), 'utf8')), proof)
      await assert.rejects(fs.lstat(own.coreRoot), { code: 'ENOENT' }); await assert.rejects(fs.lstat(own.guiRoot), { code: 'ENOENT' })
    })
}
