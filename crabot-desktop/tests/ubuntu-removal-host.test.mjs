import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { acquireExistingCliLock, releaseCliLock } from '../../scripts/lib/cli-lock.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../../scripts/lib/core-release.mjs'
import { sealDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../../scripts/lib/desktop-payload.mjs'
import { buildUbuntuMaintenanceBackend } from '../../scripts/desktop/ubuntu-maintenance-backend.mjs'
import { desktopMaintenanceNodeFiles } from '../../scripts/lib/desktop-maintenance-bootstrap.mjs'
const linux = process.platform === 'linux', require = createRequire(new URL('../package.json', import.meta.url))
let root, payload
before(async () => {
  if (!linux) return
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-node-removal-source-')))
  payload = path.join(root, 'payload')
  const core = path.join(payload, 'core'), gui = path.join(payload, 'gui'), resources = path.join(gui, 'resources')
  await fs.mkdir(path.join(core, '.product-runtime/node/bin'), { recursive: true }); await fs.mkdir(path.join(core, 'bin'))
  await fs.copyFile(process.execPath, path.join(core, '.product-runtime/node/bin/node'))
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
  const { prepareDesktopRemovalNode } = await import('../../scripts/lib/desktop-removal-host.mjs')
  await assert.rejects(prepareDesktopRemovalNode({ installRoot: '/never-accessed', operationId: randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL' })
  const { beginInitialDesktopRemovalNode } = await import('../../scripts/lib/desktop-removal-job.mjs')
  await assert.rejects(() => beginInitialDesktopRemovalNode({ installRoot: '/never-accessed', operationId: randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL' })
  const { createDesktopRemovalNodeSourceExitVerifier } = await import('../../scripts/lib/desktop-removal-source.mjs')
  assert.equal(await createDesktopRemovalNodeSourceExitVerifier({})({}), false)
})
for (const mode of ['valid', 'cancelled', 'changed-node', 'changed-backend', 'redirected-frontend', 'changed-selection', 'copy-failure', 'space', 'late-copy-change', 'late-cancel']) test('private Ubuntu Node host preparation: ' + mode, { skip: !linux, timeout: 60000 }, async t => {
  const area = await fs.mkdtemp(path.join(root, 'case-'))
  const own = await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'installation') }))
  await fs.writeFile(path.join(own.dataDir, 'preserved'), 'data and dependencies')
  const options = { installRoot: own.root, operationId: randomUUID() }, source = path.join(own.guiRoot, 'resources/crabot-maintenance-backend/progress.mjs')
  const { prepareDesktopRemovalNode } = await import('../../scripts/lib/desktop-removal-host.mjs')
  if (mode === 'cancelled') options.signal = AbortSignal.abort()
  if (mode === 'changed-node') await fs.appendFile(path.join(own.coreRoot, '.product-runtime/node/bin/node'), 'changed')
  if (mode === 'changed-backend') await fs.appendFile(source, 'changed')
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
    assert.deepEqual(names.sort(), ['node', 'crabot-maintenance', ...desktopMaintenanceNodeFiles.map(name => 'backend/' + name)].sort())
    assert.equal(names.some(name => /(^|\/)(data|core|\.product-runtime)(\/|$)/.test(name)), false)
    assert.equal(host.proof.operation_id, options.operationId)
    console.log('CRABOT_PRIVATE_NODE_PREPARATION ' + JSON.stringify({ fixed_resources_only: true, copied_node_executed: true, self_verified: true, business_started: false }))
  } else await assert.rejects(prepareDesktopRemovalNode(options))
  if (copyDirectory) await assert.rejects(fs.lstat(copyDirectory), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved'), 'utf8'), 'data and dependencies')
  for (const name of ['.desktop-removal.json', '.desktop-installing.json']) await assert.rejects(fs.lstat(path.join(own.root, name)), { code: 'ENOENT' })
})


for (const mode of ['node-job-valid', 'node-job-parent-flags', 'node-job-copy-changed', 'node-job-other-installation', 'node-job-source-verifier', 'node-job-source-exit']) test('actual private Node initial job role: ' + mode, { skip: !linux, timeout: 60000 }, async t => {
  const area = await fs.mkdtemp(path.join(root, 'node-role-'))
  const own = await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'installation') }))
  await fs.writeFile(path.join(own.dataDir, 'preserved'), 'unchanged user content')
  const cfg = { mode, own, operationId: randomUUID(), resultFile: path.join(area, 'node-result.json') }
  if (mode === 'node-job-other-installation') cfg.otherRoot = (await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'other') }))).root
  const env = { ...process.env, CRABOT_NODE_REMOVAL_FIXTURE: JSON.stringify(cfg) }
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[name]
  const running = promisify(execFile)(own.executable, mode === 'node-job-parent-flags' ? ['--no-warnings'] : [], { cwd: area, env, timeout: 50000, maxBuffer: 8192 })
  running.child.stdin.end(await fs.readFile(new URL('./fixtures/ubuntu-removal-node-parent.cjs', import.meta.url)))
  const { stdout } = await running
  let result = JSON.parse(stdout)
  if (mode === 'node-job-source-exit') {
    assert.equal(result.handoff, true)
    const { directory, host } = result, identity = require('../../scripts/lib/process-identity.cjs')
    const { probeKnownProcessExit } = require('../../scripts/lib/known-process-exit.cjs')
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
      if (Date.now() >= deadline) throw new Error('Private Node did not complete after actual source exit')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    result = JSON.parse(await fs.readFile(cfg.resultFile, 'utf8'))
    assert.deepEqual(result, { accepted: true, published: 'preparing', stopped: 'stopping', cancelled: true, ordinary_peer: false, locks_reacquired: true, source_exited: true })
  } else if (mode === 'node-job-source-verifier') assert.deepEqual(result, { accepted: true, published: 'preparing', stopped: 'stopping', cancelled: true, ordinary_peer: false, locks_reacquired: true,
    source_verifier: { preparing_rejected: true, wrong_operation_rejected: true, verified_after_stop: true, changed_copy_rejected: true } })
  else if (mode === 'node-job-valid') assert.deepEqual(result, { accepted: true, published: 'preparing', stopped: 'stopping', cancelled: true, ordinary_peer: false, locks_reacquired: true })
  else assert.deepEqual(result, { accepted: false, code: 'CRABOT_DESKTOP_REMOVAL' })
  assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved'), 'utf8'), 'unchanged user content')
  for (const installation of [own.root, cfg.otherRoot].filter(Boolean)) {
    for (const name of ['.desktop-removal.json', '.desktop-installing.json']) await assert.rejects(fs.lstat(path.join(installation, name)), { code: 'ENOENT' })
    const rootLock = await acquireExistingCliLock(installation, 'verify-node-role-released', 0)
    try {
      const dataLock = await acquireExistingCliLock(path.join(installation, 'data'), 'verify-node-role-released', 0)
      releaseCliLock(dataLock)
    } finally { releaseCliLock(rootLock) }
  }
  assert.equal((await fs.stat(own.executable)).isFile(), true)
})
