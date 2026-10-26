// Protected, packaged test actor only. No product main, business MM or data job.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const cfg = JSON.parse(fs.readFileSync(process.env.CRABOT_REMOVAL_FRAME_CONFIG, 'utf8'))
if (['publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main', 'installer-source', 'installer-ui'].includes(cfg.mode) && process.argv.some(value => value.startsWith('--crabot-removal-host='))) {
  const assert = require('node:assert/strict'), electron = require('electron')
  const native = require('./bootstrap/scripts/lib/process-identity.cjs')
  native.inspectProgramReferences = async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] })
  const reference = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopPairReference(cfg.root)
  const coreInitiallyMissing = !fs.existsSync(path.join(cfg.root, 'releases', reference.selection.core_id))
  let windows = 0, loginWrites = 0, registrationCalls = 0, lastMessage = ''; const dialogCodes = []
  electron.app.setLoginItemSettings = options => { loginWrites++; assert.deepEqual(options, { openAtLogin: false }) }
  electron.app.getLoginItemSettings = () => ({ status: 'not-registered', openAtLogin: false })
  electron.dialog.showMessageBox = async options => { lastMessage = options.message; const code = /诊断代码：([A-Z0-9_]+)/.exec(options.detail || '')?.[1]; if (code) dialogCodes.push(code); return { response: /尚未卸载完成|删除已经开始/.test(options.message) ? 2 : 0 } }
  const childProcess = require('node:child_process'), execFile = childProcess.execFile
  childProcess.execFile = (file, args, options, callback) => {
    if (file === '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister') {
      registrationCalls++; queueMicrotask(() => callback(null, '', '')); return
    }
    return execFile(file, args, options, callback)
  }
  require('node:module').syncBuiltinESMExports()
  app.on('browser-window-created', (_event, window) => {
    windows++; const preferences = window.webContents.getLastWebPreferences()
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false)
  })
  const deadline = setTimeout(() => app.exit(2), 60000)
  app.on('will-quit', () => {
    clearTimeout(deadline)
    const record = require('./bootstrap/scripts/lib/desktop-removal-record.cjs').readDesktopRemoval(cfg.root)
    const complete = record?.phase === 'completed'
    fs.writeFileSync(cfg.resultFile, JSON.stringify({ accepted: complete, published: !!record, retained: !!record, cancelled: false,
      cancelRejected: false, sourceExited: complete, sourceExitRejected: false, stopRejected: false, cancellationReplyLost: false,
      lost: false, proofRetained: true, programsRemoved: complete, completionVerified: complete, controlledResourceObservation: true,
      removalRetried: false, actual_main: true, actual_source: cfg.mode === 'publish-source-remove-source', core_initially_missing: coreInitiallyMissing, actual_progress_windows: windows, os_api_mocked: true, login_writes: loginWrites,
      registration_calls: registrationCalls, dialog_codes: dialogCodes, message: lastMessage }) + '\n')
  })
  void import(pathToFileURL(path.join(__dirname, 'full-main.js')).href).catch(error => {
    fs.writeFileSync(cfg.resultFile, JSON.stringify({ accepted: false, code: error.code, message: String(error.message).slice(0, 256) })); app.exit(1)
  })
  return
}

const host = process.argv.includes('--fixture-removal-host')
const sourceExitMode = ['publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'resume-lease-source-exit', 'publish-source-remove', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main', 'publish-source-remove-operation', 'publish-source-remove-cancel-retry', 'publish-source-remove-mac-login', 'publish-source-remove-complete', 'publish-source-remove-windows-uninstall', 'publish-source-remove-retry', 'resume-lease-source-remove'].includes(cfg.mode)
const profile = host ? path.resolve(process.resourcesPath, process.platform === 'darwin' ? '../../../..' : '../..', 'profile') : path.join(cfg.root, 'data/desktop-profile')
fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); app.setPath('userData', profile)
const load = name => import(pathToFileURL(path.join(__dirname, 'bootstrap/scripts/lib', name)).href)
let prepared, child, releaseDataLock
const actorStarted = Date.now()
function stage(name) {
  if (host && cfg.stageFile) fs.writeFileSync(cfg.stageFile, JSON.stringify({ stage: name, elapsed_ms: Date.now() - actorStarted }) + '\n')
}
// The retry scenario performs eight full GUI checks; this bounds only the
// finite test actor, not a product stop, source exit or removal operation.
const timer = setTimeout(() => app.exit(2), cfg.mode.includes('source-remove') ? 120000 : 60000)
async function send(result) {
  await new Promise((resolve, reject) => process.send(result, error => error ? reject(error) : resolve()))
}
async function assertIndependentHostLocation() {
  const assert = require('node:assert/strict'), native = require('./bootstrap/scripts/lib/process-identity.cjs')
  stage('host-location-inspection')
  assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(path.dirname(profile)))
  if (process.platform === 'darwin') {
    const reference = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopPairReference(cfg.root)
    const observed = await native.inspectProgramReferences({ roots: [path.join(cfg.root, 'app/releases', reference.selection.gui_id),
      path.join(cfg.root, 'releases', reference.selection.core_id)], files: [] })
    assert.equal(observed.incomplete, false)
    assert.equal(observed.unknown_pids.includes(process.pid), false)
    assert.equal(observed.processes.some(value => value.pid === process.pid), false)
  }
  stage('host-location-confirmed')
}
async function removePrograms(lease) {
  const assert = require('node:assert/strict'), native = require('./bootstrap/scripts/lib/process-identity.cjs')
  const physical = require('./bootstrap/scripts/lib/physical-fs.cjs')
  const original = native.inspectProgramReferences, rename = physical.promises.rename, unlink = physical.unlinkSync, readFile = physical.promises.readFile
  const started = Date.now(); let pinReads = 0
  let userEntries
  if (['publish-source-remove-mac-login', 'publish-source-remove-operation'].includes(cfg.mode)) {
    const own = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopInstallation(cfg.root)
    const record = JSON.parse(fs.readFileSync(path.join(cfg.root, '.desktop-removal.json')))
    const { registerInstallationEntries, integrationRoot } = await import(pathToFileURL(path.join(__dirname, 'installation-entries.js')).href)
    const home = require('./bootstrap/scripts/lib/desktop-management.cjs').ensurePrivateDataRoot(path.join(cfg.root, 'data/finite-user-home'))
    const env = {}, shell = require('electron').shell
    const prepared = { installRoot: cfg.root, installation_id: own.record.installation_id, selection: record.source_selection,
      guiRoot: path.join(cfg.root, 'app/releases', record.source_selection.gui_id), coreRoot: path.join(cfg.root, 'releases', record.source_selection.core_id) }
    await registerInstallationEntries(prepared, { home, env, shell, platform: process.platform, registerMac: async () => {} })
    userEntries = { home, env, shell, unregisterMac: async () => {}, locator: path.join(integrationRoot(home, process.platform, env), 'installation.json') }
  }
  const observed = async (name, run) => { stage(name + ":start"); const value = await run(); stage(name + ":done"); return value }
  if (cfg.removalPinDelayMs) physical.promises.readFile = async (...args) => {
    if (args[0] === path.join(process.resourcesPath, "desktop-release.json")) {
      pinReads++; await new Promise(resolve => setTimeout(resolve, cfg.removalPinDelayMs))
    }
    return readFile(...args)
  }
  const fence = path.join(cfg.root, '.desktop-removal.json'), read = () => JSON.parse(fs.readFileSync(fence))
  const clear = async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] })
  // Only resource answers are controlled here. Parent/source identities, OS
  // exits, locks, hashes, file mutations and the private host remain actual.
  native.inspectProgramReferences = clear
  try {
    if (cfg.mode === 'publish-source-remove-operation') {
      const { runRemovalOperation } = await import(pathToFileURL(path.join(__dirname, 'removal-operation.js')).href)
      const { removeDesktopUserEntries } = await import(pathToFileURL(path.join(__dirname, 'installation-removal.js')).href)
      const { finishDesktopRemoval } = await load('desktop-removal-job.mjs')
      const options = { installRoot: cfg.root, operationId: cfg.operationId }
      let displays = 0, disabled = false, calls = 0
      const app = { getLoginItemSettings: () => ({ status: 'not-registered', openAtLogin: false }), setLoginItemSettings: value => { calls++; assert.deepEqual(value, { openAtLogin: false }) } }
      const result = await runRemovalOperation({ lease,
        openProgress: async () => { displays++; return { update: (_message, cancellable) => { if (!cancellable) disabled = true }, close: () => { displays-- } } },
        decide: async failure => { throw new Error('Unexpected operation failure: ' + failure.code) },
        removeEntries: () => removeDesktopUserEntries({ ...options, ...userEntries, app }),
        finish: () => finishDesktopRemoval(options),
      })
      assert.equal(result, 'completed'); assert.equal(displays, 0); assert.equal(disabled, true); assert.equal(calls, 1)
      assert.equal(read().phase, 'completed'); assert.equal(fs.existsSync(userEntries.locator), false)
      assert.throws(() => fs.lstatSync(path.join(userEntries.home, 'Applications/Crabot.app')), { code: 'ENOENT' })
      assert.equal(fs.readFileSync(path.join(cfg.root, 'data/preserved-user-file'), 'utf8'), 'user bytes')
      return { programsRemoved: true, completionVerified: true, controlledResourceObservation: true, removalRetried: false, displayMocked: true, macLoginApiMocked: true }
    }
    assert.throws(() => lease.retryRemovePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    if (cfg.mode === 'publish-source-remove-retry') {
      const core = path.join(cfg.root, 'releases', read().source_selection.core_id), before = fs.readFileSync(fence)
      native.inspectProgramReferences = async () => ({ complete: false, incomplete: false, processes: [], unknown_pids: [process.pid] })
      const blocked = lease.removePrograms(); assert.equal(blocked, lease.removePrograms())
      await assert.rejects(blocked, { code: 'CRABOT_DESKTOP_PROGRAM_REFERENCES', stage: 'before-removing' })
      assert.equal(read().phase, 'stopping'); assert.ok(fs.existsSync(path.join(core, 'program.mjs')))
      native.inspectProgramReferences = clear
      const pin = path.join(process.resourcesPath, 'desktop-release.json'), bytes = fs.readFileSync(pin)
      fs.appendFileSync(pin, ' ')
      await observed("retry-1", () => assert.rejects(lease.retryRemovePrograms(), { code: 'CRABOT_CORE_INTEGRITY' })); fs.writeFileSync(pin, bytes)
      native.inspectProgramReferences = async () => { fs.writeFileSync(fence, JSON.stringify({ ...read(), phase: 'completed' }) + '\n'); return clear() }
      await observed("retry-2", () => assert.rejects(lease.retryRemovePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' })); fs.writeFileSync(fence, before)
      native.inspectProgramReferences = clear
      physical.promises.rename = async (...args) => { if (args[1] === fence) throw Object.assign(new Error('fixture removing not committed'), { code: 'EIO' }); return rename(...args) }
      await observed("retry-3", () => assert.rejects(lease.retryRemovePrograms(), { code: 'EIO' })); assert.equal(read().phase, 'stopping')
      physical.promises.rename = async (...args) => {
        const result = await rename(...args)
        if (args[1] === fence && read().phase === 'removing') throw Object.assign(new Error('fixture lost removing reply'), { code: 'EIO' })
        return result
      }
      await observed("retry-4", () => assert.rejects(lease.retryRemovePrograms(), { code: 'EIO' })); physical.promises.rename = rename
      assert.equal(read().phase, 'removing'); assert.ok(fs.existsSync(path.join(core, 'program.mjs')))
      await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      const removing = fs.readFileSync(fence)
      fs.writeFileSync(fence, JSON.stringify({ ...read(), phase: 'completed' }) + '\n')
      await observed("retry-5", () => assert.rejects(lease.retryRemovePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' })); fs.writeFileSync(fence, removing)
      const gui = path.join(cfg.root, 'app/releases', read().source_selection.gui_id)
      let deleted
      physical.unlinkSync = file => {
        const result = unlink(file)
        if (!deleted && file.startsWith(gui + path.sep)) { deleted = file; throw Object.assign(new Error('fixture lost file removal reply'), { code: 'EIO' }) }
        return result
      }
      await observed("retry-6", () => assert.rejects(lease.retryRemovePrograms(), { code: 'EIO' })); physical.unlinkSync = unlink
      assert.ok(deleted); assert.equal(fs.existsSync(deleted), false); assert.equal(read().phase, 'removing')
      const unknown = path.join(core, 'user-kept.txt'); fs.writeFileSync(unknown, 'custom program directory file')
      const retry = lease.retryRemovePrograms(); assert.equal(retry, lease.retryRemovePrograms()); assert.equal(retry, lease.removePrograms())
      assert.throws(() => lease.close(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      const partial = await observed("partial-removal", () => retry)
      assert.ok(partial.removed.length > 0); assert.equal(partial.retained.length, 1)
      assert.equal(fs.readFileSync(unknown, 'utf8'), 'custom program directory file'); assert.equal(await lease.removePrograms(), partial)
      await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      fs.unlinkSync(unknown) // Explicit fixture-user action; never product cleanup.
    }
    let first, removing = 0
    if (cfg.mode === 'publish-source-remove-cancel-retry') {
      const cancelled = new AbortController(); cancelled.abort()
      await assert.rejects(lease.removePrograms(cancelled.signal, () => removing++), { name: 'AbortError' })
      assert.equal(read().phase, 'stopping'); assert.equal(removing, 0)
      assert.ok(fs.existsSync(path.join(cfg.root, 'releases', read().source_selection.core_id, 'program.mjs')))
      const retry = new AbortController()
      first = lease.retryRemovePrograms(retry.signal, () => { removing++; assert.equal(read().phase, 'stopping') })
    } else first = cfg.mode === 'publish-source-remove-retry' ? lease.retryRemovePrograms() : lease.removePrograms()
    assert.equal(first, lease.removePrograms())
    assert.throws(() => lease.close(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    const result = await observed("final-removal", () => first)
    if (cfg.mode === 'publish-source-remove-cancel-retry') assert.equal(removing, 1)
    assert.equal((await lease.current()).phase, 'removing')
    if (cfg.mode !== 'publish-source-remove-retry') assert.ok(result.removed.length > 0)
    assert.equal(result.retained.length, 0)
    assert.equal(await lease.removePrograms(), result); assert.equal(await lease.retryRemovePrograms(), result)
    assert.equal(fs.readFileSync(path.join(cfg.root, 'data/preserved-user-file'), 'utf8'), 'user bytes')
    const macLoginCleaned = cfg.mode === 'publish-source-remove-mac-login'
    if (macLoginCleaned) {
      const { removeMacLoginStartupEntry, removeDesktopUserEntries } = await import(pathToFileURL(path.join(__dirname, 'installation-removal.js')).href)
      let status = 'requires-approval', accept = false, writes = 0
      const api = { getLoginItemSettings: () => ({ status, openAtLogin: status === 'enabled' }),
        setLoginItemSettings: options => { assert.deepEqual(options, { openAtLogin: false }); writes++; if (accept) status = 'not-registered' } }
      const input = { installRoot: cfg.root, operationId: cfg.operationId, app: api }
      await assert.rejects(removeMacLoginStartupEntry({ ...input, operationId: require('node:crypto').randomUUID() }))
      const cwd = process.cwd(); process.chdir(cfg.root)
      try { await assert.rejects(removeMacLoginStartupEntry(input)) } finally { process.chdir(cwd) }
      assert.equal(writes, 0)
      await assert.rejects(removeMacLoginStartupEntry(input), { code: 'CRABOT_INSTALL_REGISTRATION' })
      assert.equal(read().phase, 'removing'); accept = true
      await removeMacLoginStartupEntry(input); await removeDesktopUserEntries({ ...input, ...userEntries })
      assert.equal(fs.existsSync(userEntries.locator), false); assert.throws(() => fs.lstatSync(path.join(userEntries.home, 'Applications/Crabot.app')), { code: 'ENOENT' })
      assert.equal(writes, 3); assert.equal(status, 'not-registered'); assert.equal(read().phase, 'removing')
      assert.equal(fs.readFileSync(path.join(cfg.root, 'data/preserved-user-file'), 'utf8'), 'user bytes')
    }
    let completionVerified = false
    if (cfg.mode === 'publish-source-remove-complete') {
      const { finishDesktopRemoval } = await load('desktop-removal-job.mjs')
      const input = { installRoot: cfg.root, operationId: cfg.operationId }
      await assert.rejects(finishDesktopRemoval({ ...input, operationId: require('node:crypto').randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL' })
      const core = path.join(cfg.root, 'releases', read().source_selection.core_id), unknown = path.join(core, 'custom-kept.txt')
      fs.mkdirSync(core, { mode: 0o700 }); fs.writeFileSync(unknown, 'user-added program file')
      await assert.rejects(finishDesktopRemoval(input), { code: 'CRABOT_DESKTOP_REMOVAL' })
      assert.equal(fs.readFileSync(unknown, 'utf8'), 'user-added program file')
      fs.unlinkSync(unknown); fs.rmdirSync(core) // Explicit fixture-user cleanup.
      const bytes = fs.readFileSync(fence)
      fs.writeFileSync(fence, JSON.stringify({ ...read(), phase: 'stopping' }) + '\n')
      await assert.rejects(finishDesktopRemoval(input), { code: 'CRABOT_DESKTOP_REMOVAL' }); fs.writeFileSync(fence, bytes)
      const records = path.join(cfg.root, 'data/module-runtime-registry/records')
      fs.mkdirSync(records, { recursive: true }); fs.writeFileSync(path.join(records, 'unsettled.json'), '{}')
      await assert.rejects(finishDesktopRemoval(input), { code: 'CRABOT_DESKTOP_REMOVAL' }); fs.unlinkSync(path.join(records, 'unsettled.json'))
      physical.promises.rename = async (...args) => {
        const value = await rename(...args)
        if (args[1] === fence) throw Object.assign(new Error('fixture completed reply lost'), { code: 'EIO' })
        return value
      }
      await assert.rejects(finishDesktopRemoval(input), { code: 'EIO' }); physical.promises.rename = rename
      assert.equal(read().phase, 'completed')
      await finishDesktopRemoval(input); await finishDesktopRemoval(input)
      assert.equal(read().phase, 'completed'); assert.equal(fs.readFileSync(path.join(cfg.root, 'data/preserved-user-file'), 'utf8'), 'user bytes')
      completionVerified = true
    }
    const windowsUninstallEntryRemoved = cfg.mode === 'publish-source-remove-windows-uninstall'
    if (windowsUninstallEntryRemoved) {
      const { removeWindowsUninstallEntry } = await import(pathToFileURL(path.join(__dirname, 'installation-removal.js')).href)
      await assert.rejects(removeWindowsUninstallEntry({ installRoot: cfg.root, operationId: require('node:crypto').randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL' })
      await removeWindowsUninstallEntry({ installRoot: cfg.root, operationId: cfg.operationId })
      await removeWindowsUninstallEntry({ installRoot: cfg.root, operationId: cfg.operationId })
      assert.equal(read().phase, 'removing')
    }
    return { windowsUninstallEntryRemoved, completionVerified, macLoginCleaned, macLoginApiMocked: macLoginCleaned, programsRemoved: true, controlledResourceObservation: true, removalRetried: cfg.mode === 'publish-source-remove-retry', removalPinReads: pinReads, removalElapsedMs: Date.now() - started }
  } finally { native.inspectProgramReferences = original; physical.promises.rename = rename; physical.unlinkSync = unlink; physical.promises.readFile = readFile }
}
async function publication() {
  const { beginInitialDesktopRemoval } = await load('desktop-removal-job.mjs')
  const physical = require('./bootstrap/scripts/lib/physical-fs.cjs')
  const removal = require('./bootstrap/scripts/lib/desktop-removal-record.cjs')
  const { readDesktopRemovalProof } = await load('desktop-removal-proof.mjs')
  const assert = require('node:assert/strict')
  const { acquireExistingCliLock, releaseCliLock } = await load('cli-lock.mjs')
  const originalLink = physical.promises.link, originalUnlink = physical.promises.unlink, originalRename = physical.promises.rename
  if (cfg.mode === 'publish-lost-reply') physical.promises.link = async (...args) => {
    const result = await originalLink(...args)
    if (args[1] === path.join(cfg.root, '.desktop-removal.json')) throw Object.assign(new Error('fixture lost publication reply'), { code: 'EIO' })
    return result
  }
  if (['publish-stop-lost', 'publish-stop-lost-retry'].includes(cfg.mode)) physical.promises.rename = async (...args) => {
    const result = await originalRename(...args)
    if (args[1] === path.join(cfg.root, '.desktop-removal.json')) throw Object.assign(new Error('fixture lost stopping reply'), { code: 'EIO' })
    return result
  }
  let cancellationReplyLost = false
  if (cfg.mode === 'publish-cancel-lost') physical.promises.unlink = async file => {
    const result = await originalUnlink(file)
    if (file === path.join(cfg.root, '.desktop-removal.json') && !cancellationReplyLost) {
      cancellationReplyLost = true; throw Object.assign(new Error('fixture lost cancellation reply'), { code: 'EIO' })
    }
    return result
  }
  let programResult = {}, lease, lost = false, cancelRejected = false, cancelled = false, stopApplied = false, stopRejected = false, sourceExited = false, sourceExitRejected = false
  try {
    try { lease = await beginInitialDesktopRemoval({ installRoot: cfg.root, operationId: cfg.operationId }) }
    catch (error) { if (cfg.mode !== 'publish-lost-reply' || error.code !== 'EIO') throw error; lost = true }
    const initial = await readDesktopRemovalProof(cfg.root)
    if (cfg.mode.includes('source-remove')) assert.throws(() => lease.removePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    if (['publish-stop-retry', 'publish-stop-lost-retry'].includes(cfg.mode)) {
      assert.throws(() => lease.retryStop(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      const runtime = path.join(cfg.root, 'data/instance-runtime.json'), bytes = fs.readFileSync(runtime)
      if (cfg.mode === 'publish-stop-retry') fs.writeFileSync(runtime, JSON.stringify({ ...JSON.parse(bytes), install_root: path.dirname(cfg.root) }) + '\n')
      await assert.rejects(lease.stop()); stopRejected = true
      if (cfg.mode === 'publish-stop-retry') fs.writeFileSync(runtime, bytes)
      if (cfg.mode === 'publish-stop-lost-retry') {
        const fence = path.join(cfg.root, '.desktop-removal.json'), committed = fs.readFileSync(fence)
        const changed = JSON.stringify({ ...JSON.parse(committed), phase: 'completed' }) + '\n'
        fs.writeFileSync(fence, changed)
        await assert.rejects(lease.retryStop(), { code: 'CRABOT_DESKTOP_REMOVAL' })
        assert.equal(fs.readFileSync(fence, 'utf8'), changed); fs.writeFileSync(fence, committed)
      }
      const retry = lease.retryStop(); assert.equal(retry, lease.retryStop()); assert.equal(retry, lease.stop())
      assert.throws(() => lease.close(), { code: 'CRABOT_DESKTOP_REMOVAL' }); await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      await retry; await lease.retryStop(); stopApplied = (await lease.current()).phase === 'stopping'
    }
    if (cfg.mode === 'publish-stop') {
      const first = lease.stop(), second = lease.stop(); if (first !== second) throw new Error('Repeated stop did not share its result')
      assert.throws(() => lease.close(), { code: 'CRABOT_DESKTOP_REMOVAL' }); await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      await first; await lease.stop(); stopApplied = (await lease.current()).phase === 'stopping'
    }
    if (['publish-stop-wrong-root', 'publish-stop-lost'].includes(cfg.mode)) {
      await assert.rejects(lease.stop()); stopRejected = true
    }
    if (cfg.mode === 'publish-source-verifier') {
      await lease.stop()
      const answer = once(process, 'message')
      await send({ kind: 'desktop_removal_source_exit', installation_id: initial.record.installation_id, operation_id: cfg.operationId, source_selection: initial.record.source_selection })
      const [response] = await answer
      assert.equal(response?.kind, 'source-verifier-checked'); assert.equal(response.accepted, true)
    }
    else if (cfg.mode.startsWith('publish-source-')) {
      await lease.stop()
      if (cfg.mode.includes('source-remove')) assert.throws(() => lease.removePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      if (['publish-source-retry', 'publish-source-late-exit'].includes(cfg.mode)) {
        const native = require('./bootstrap/scripts/lib/process-identity.cjs'), source = native.inspectProcess(native.inspectProcess(process.pid).parent)
        assert.ok(source)
        assert.throws(() => lease.retrySourceExit(), { code: 'CRABOT_DESKTOP_REMOVAL' })
        await assert.rejects(lease.exitSource()); sourceExitRejected = true
        if (cfg.mode === 'publish-source-late-exit') {
          const { probeKnownProcessExit } = require('./bootstrap/scripts/lib/known-process-exit.cjs'), deadline = performance.now() + 5000
          while (probeKnownProcessExit([source]).state !== 'stopped') {
            if (performance.now() >= deadline) throw new Error('Late source did not actually exit')
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        } else {
          const pin = path.join(process.resourcesPath, 'desktop-release.json'), bytes = fs.readFileSync(pin)
          fs.appendFileSync(pin, ' ')
          await assert.rejects(lease.retrySourceExit(), { code: 'CRABOT_CORE_INTEGRITY' })
          fs.writeFileSync(pin, bytes)
        }
        const retry = lease.retrySourceExit(); assert.equal(retry, lease.retrySourceExit()); assert.equal(retry, lease.exitSource())
        assert.throws(() => lease.close(), { code: 'CRABOT_DESKTOP_REMOVAL' }); await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
        await retry; await lease.retrySourceExit(); await assertIndependentHostLocation(); sourceExited = true
      }
      else if (cfg.mode === 'publish-source-exit' || cfg.mode.includes('source-remove')) { await lease.exitSource(); await assertIndependentHostLocation(); sourceExited = true; if (cfg.mode.includes('source-remove')) programResult = await removePrograms(lease) }
      else { await assert.rejects(lease.exitSource()); sourceExitRejected = true; await assert.rejects(lease.removePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' }); assert.equal((await lease.current()).phase, 'stopping') }
    }
    if (cfg.mode === 'publish-module') {
      fs.mkdirSync(path.join(cfg.root, 'data/module-runtime-registry/records'), { recursive: true })
      fs.writeFileSync(path.join(cfg.root, 'data/module-runtime-registry/records/unsettled.json'), '{}')
    }
    if (cfg.mode === 'publish-live') fs.writeFileSync(path.join(cfg.root, 'data/mm.pid'), String(process.pid))
    if (cfg.mode === 'publish-damaged') fs.appendFileSync(path.join(cfg.root, 'releases', initial.record.source_selection.core_id, 'program.mjs'), '\n// changed')
    if (cfg.mode === 'publish-replaced-record') {
      const changed = { ...initial.record, operation_id: '11111111-1111-4111-8111-111111111111' }
      await (await load('desktop-preparation-files.mjs')).privateJson(path.join(cfg.root, '.desktop-removal.json'), changed, true)
    }
    if (!['publish-close', 'publish-lost-reply', 'publish-source-ignore', 'publish-source-disconnect', 'publish-source-remove', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main', 'publish-source-remove-operation', 'publish-source-remove-cancel-retry', 'publish-source-remove-mac-login', 'publish-source-remove-complete', 'publish-source-remove-windows-uninstall', 'publish-source-remove-retry'].includes(cfg.mode)) {
      try { await lease.cancel(); cancelled = true; await lease.cancel() }
      catch (error) { if (['publish-cancel', 'publish-stop', 'publish-stop-retry', 'publish-stop-lost-retry', 'publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'publish-source-verifier'].includes(cfg.mode)) throw error; if (cfg.mode === 'publish-cancel-lost' && cancellationReplyLost) { await lease.cancel(); cancelled = true } else cancelRejected = error.code === 'CRABOT_DESKTOP_REMOVAL' }
    }
    const record = removal.readDesktopRemoval(cfg.root)
    return { ...programResult, accepted: true, published: true, cancelled, cancelRejected, lost, retained: Boolean(record), operation_id: record?.operation_id,
      cancellationReplyLost, stopApplied, stopRejected, sourceExited, sourceExitRejected, phase: record?.phase, proofRetained: fs.existsSync(path.join(cfg.root, 'app/removals', cfg.operationId, 'proof.json')) }
  } finally {
    physical.promises.link = originalLink; physical.promises.unlink = originalUnlink; physical.promises.rename = originalRename
    await lease?.close()
    if (['publish-stop', 'publish-stop-retry', 'publish-stop-lost-retry'].includes(cfg.mode)) assert.throws(() => lease.stop(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    if (['publish-stop-retry', 'publish-stop-lost-retry'].includes(cfg.mode)) assert.throws(() => lease.retryStop(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    if (['publish-source-retry', 'publish-source-late-exit'].includes(cfg.mode)) assert.throws(() => lease.retrySourceExit(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    if (cfg.mode.includes('source-remove')) { assert.throws(() => lease.removePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' }); assert.throws(() => lease.retryRemovePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
    for (const directory of [cfg.root, path.join(cfg.root, 'data')]) {
      const lock = await acquireExistingCliLock(directory, 'fixture-confirm-release', 0); releaseCliLock(lock)
    }
  }
}
async function main() {
  await app.whenReady()
  if (host) {
    let result
    try { if (cfg.mode.startsWith('installer-')) {
      const assert = require('node:assert/strict'), native = require('./bootstrap/scripts/lib/process-identity.cjs')
      const { captureInstallerRemovalGuiHost } = await load('desktop-removal-installer.mjs')
      const input = { installRoot: cfg.root, operationId: cfg.mode === 'installer-wrong-operation' ? require('node:crypto').randomUUID() : cfg.operationId, installerPayload: cfg.installerPayload }
      const captured = await captureInstallerRemovalGuiHost(input)
      assert.deepEqual(captured.proof.source_selection, cfg.originalSelection)
      assert.notEqual(captured.facts.source_installer.pid, captured.facts.host_gui.pid)
      const { resumeInstallerDesktopRemoval } = await load('desktop-removal-job.mjs')
      native.inspectProgramReferences = async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] })
      const lease = await resumeInstallerDesktopRemoval(input)
      try {
        await lease.stop(); await lease.exitSource()
        assert.ok(native.sameProcess(captured.facts.source_installer, native.inspectProcess(captured.facts.source_installer.pid)))
        await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
        const removed = await lease.removePrograms(); assert.deepEqual(removed.retained, [])
        let loginWrites = 0
        if (process.platform === 'darwin') {
          const { removeMacLoginStartupEntry } = await import(pathToFileURL(path.join(__dirname, 'installation-removal.js')).href)
          await removeMacLoginStartupEntry({ ...input, maintenancePayload: lease.hostPayload, app: {
            setLoginItemSettings: value => { assert.deepEqual(value, { openAtLogin: false }); loginWrites++ },
            getLoginItemSettings: () => ({ status: 'not-registered', openAtLogin: false }) } })
        }
        assert.equal(fs.readFileSync(path.join(cfg.root, 'data/preserved-user-file'), 'utf8'), 'user bytes')
        result = { accepted: true, original_proof_preserved: true, programsRemoved: true, loginWrites, parent_remained_alive: true, controlledResourceObservation: true }
      } finally { lease.close() }
    } else if (cfg.mode.startsWith('resume-')) {
      const { captureExistingRemovalGuiHost } = await load('desktop-removal-frame.mjs')
      const captured = await captureExistingRemovalGuiHost({ installRoot: cfg.root,
        operationId: cfg.mode === 'resume-wrong-operation' ? '11111111-1111-4111-8111-111111111111' : cfg.operationId })
      result = { accepted: true, resumed: true, record: captured.record, frame: captured.facts }
      if (cfg.mode.startsWith('resume-lease-')) {
        const { resumeDesktopRemoval } = await load('desktop-removal-job.mjs'), assert = require('node:assert/strict')
        const lease = await resumeDesktopRemoval({ installRoot: cfg.root,
          operationId: cfg.mode === 'resume-lease-wrong-operation' ? '11111111-1111-4111-8111-111111111111' : cfg.operationId })
        try {
          const first = lease.stop(); assert.equal(first, lease.stop()); await first
          result.phase_after_stop = (await lease.current()).phase
          if (cfg.mode === 'resume-lease-completed') assert.throws(() => lease.removePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' })
          if (sourceExitMode) { await lease.exitSource(); await assertIndependentHostLocation(); result.sourceExited = true; if (cfg.mode.includes('source-remove')) Object.assign(result, await removePrograms(lease)) }
          if (cfg.mode === 'resume-lease-cancel') { await lease.cancel(); result.lease_cancelled = true }
          else if (['resume-lease-removing', 'resume-lease-completed', 'resume-lease-core-missing'].includes(cfg.mode)) {
            await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' }); result.lease_cancel_rejected = true
          }
        } finally { lease.close() }
      }
    } else if (cfg.mode.startsWith('publish-')) { result = await publication(); } else { const { inspectInitialRemovalGuiHost } = await load('desktop-removal-frame.mjs'); const frame = await inspectInitialRemovalGuiHost({ installRoot: cfg.inspectRoot || cfg.root, operationId: cfg.operationId }); result = { accepted: true, frame } } }
    catch (error) { result = { accepted: false, code: error.code, stage: error.stage, message: String(error.message).slice(0, 256) } }
    if (sourceExitMode || cfg.mode === 'publish-source-disconnect') {
      fs.writeFileSync(cfg.resultFile, JSON.stringify(result)); if (!result.accepted && process.connected) await send(result)
    }
    else await send(result)
    return
  }
  if (cfg.mode === 'publish-source-remove-source') {
    app.on('window-all-closed', () => {}) // Match the ordinary source Main lifetime.
    const electron = require('electron'), cp = require('node:child_process'), native = require('./bootstrap/scripts/lib/process-identity.cjs')
    const originalSpawn = cp.spawn
    let sourceWindows = 0; app.on('browser-window-created', () => { sourceWindows++ })
    electron.dialog.showMessageBox = async () => ({ response: 1 })
    cp.spawn = (executable, args, options) => {
      if (process.platform === 'linux' && args.some(value => value.startsWith('--crabot-removal-host='))) options = { ...options, env: { ...options.env, GITHUB_ACTIONS: 'true', CRABOT_NODE_REMOVAL_TEST_RESULT: cfg.resultFile, CRABOT_NODE_REMOVAL_TEST_STAGE: cfg.stageFile } }
      const child = originalSpawn(executable, args, options)
      if (args.some(value => value.startsWith('--crabot-removal-host='))) child.once('spawn', () => {
        const gui = process.platform === 'darwin' ? path.resolve(path.dirname(executable), '../../..') : path.dirname(executable)
        void send({ handoff: true, host: native.inspectProcess(child.pid), directory: process.platform === 'linux' ? path.dirname(executable) : path.dirname(gui), source_progress_windows: sourceWindows })
      })
      return child
    }
    require('node:module').syncBuiltinESMExports()
    const { startGuiRemovalFromSource } = await import(pathToFileURL(path.join(__dirname, 'source-entry.js')).href)
    const options = { installRoot: cfg.root, operationId: cfg.operationId, beginExit: () => () => {} }
    const operation = startGuiRemovalFromSource(options)
    require('node:assert/strict').equal(operation, startGuiRemovalFromSource(options))
    await operation
    return
  }
  if (cfg.mode.startsWith('installer-')) {
    const assert = require('node:assert/strict'), crypto = require('node:crypto')
    const { captureDesktopRemovalProof } = await load('desktop-removal-proof.mjs')
    const { privateJson } = await load('desktop-preparation-files.mjs')
    if (['installer-source', 'installer-ui'].includes(cfg.mode)) {
      const own = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopSelection(cfg.root)
      const { registerInstallationEntries } = await import(pathToFileURL(path.join(__dirname, 'installation-entries.js')).href)
      await registerInstallationEntries({ installRoot: own.root, installation_id: own.record.installation_id,
        coreRoot: own.coreRoot, guiRoot: own.guiRoot, selection: own.selection }, {
        home: process.env.HOME, env: process.env, platform: process.platform, shell: require('electron').shell, registerMac: async () => {} })
    }
    const proof = await captureDesktopRemovalProof(cfg.root, cfg.operationId)
    const directory = path.join(cfg.root, 'app/removals', cfg.operationId)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(directory), 0o700)
    await privateJson(path.join(directory, 'proof.json'), proof)
    await privateJson(path.join(cfg.root, '.desktop-removal.json'), { schema_version: 1, installation_id: proof.installation_id,
      operation_id: cfg.operationId, source_selection: proof.source_selection, phase: 'removing',
      proof_sha256: crypto.createHash('sha256').update(JSON.stringify(proof)+'\n').digest('hex') })
    cfg.installerPayload = path.join(process.resourcesPath, 'offline'); cfg.originalSelection = proof.source_selection
    fs.writeFileSync(process.env.CRABOT_REMOVAL_FRAME_CONFIG, JSON.stringify(cfg))
    fs.rmSync(path.join(cfg.root, 'releases', proof.source_selection.core_id), { recursive: true })
    fs.rmSync(path.join(cfg.root, 'app/releases', proof.source_selection.gui_id), { recursive: true })
    if (cfg.mode === 'installer-ui') {
      const electron = require('electron'), native = require('./bootstrap/scripts/lib/process-identity.cjs')
      app.on('window-all-closed', () => {})
      native.inspectProgramReferences = async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] })
      const decisions = []
      electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cfg.root] })
      electron.dialog.showMessageBox = async options => {
        decisions.push(options.title)
        if (options.title === '安装 Crabot') return { response: 0 }
        if (['卸载尚未完成', '卸载 Crabot'].includes(options.title)) return { response: 1 }
        throw Error('Unexpected installer dialog: ' + options.title + ': ' + options.message)
      }
      const exit = app.exit.bind(app)
      app.exit = code => {
        clearTimeout(timer)
        const result = fs.existsSync(cfg.resultFile) ? JSON.parse(fs.readFileSync(cfg.resultFile, 'utf8')) : { accepted: false }
        void send({ ...result, installer_decisions: decisions, actual_installer_main: true, original_proof_preserved: true,
          parent_remained_alive: true, loginWrites: result.login_writes, source_completed_cleanup: code === 0 }).finally(() => exit(code))
      }
      void import(pathToFileURL(path.join(__dirname, 'installer-main.js')).href).catch(() => app.exit(1))
      await new Promise(() => {})
    }
    if (cfg.mode === 'installer-source') {
      const electron = require('electron'), native = require('./bootstrap/scripts/lib/process-identity.cjs')
      app.on('window-all-closed', () => {})
      electron.dialog.showMessageBox = async () => ({ response: 1 })
      native.inspectProgramReferences = async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] })
      const { startInstallerRemovalFromSource } = await import(pathToFileURL(path.join(__dirname, 'source-entry.js')).href)
      await startInstallerRemovalFromSource({ installRoot: cfg.root, operationId: cfg.operationId, installerPayload: cfg.installerPayload })
      const result = JSON.parse(fs.readFileSync(cfg.resultFile, 'utf8'))
      await send({ ...result, original_proof_preserved: true, parent_remained_alive: true, loginWrites: result.login_writes, source_completed_cleanup: true })
      return
    }
    prepared = await (await load('desktop-removal-host.mjs')).prepareInstallerDesktopRemovalGui({ payload: cfg.installerPayload, installRoot: cfg.root, operationId: cfg.operationId })
    if (cfg.mode === 'installer-changed-copy') fs.appendFileSync(path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources/desktop-release.json' : 'resources/desktop-release.json'), ' ')
    child = spawn(prepared.executable, ['--fixture-removal-host'], { env: process.env, cwd: prepared.directory, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const stopped = once(child, 'exit'), [result] = await once(child, 'message')
    await stopped
    await send({ ...result, directory: prepared.directory })
    return
  }
  if (cfg.mode.startsWith('resume-')) {
    const backend = await load('desktop-removal-host.mjs'), assert = require('node:assert/strict')
    prepared = await backend.prepareDesktopRemovalGui({ installRoot: cfg.root, operationId: cfg.operationId })
    fs.writeFileSync(process.env.CRABOT_REMOVAL_FRAME_CONFIG, JSON.stringify({ ...cfg, mode: 'publish-close' }))
    child = spawn(prepared.executable, ['--fixture-removal-host'], { env: process.env, cwd: prepared.directory, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const firstExit = once(child, 'exit'), [first] = await once(child, 'message')
    assert.equal(first.accepted, true); assert.equal(first.published, true); assert.equal((await firstExit)[0], 0)
    fs.rmSync(prepared.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); prepared = undefined
    fs.writeFileSync(process.env.CRABOT_REMOVAL_FRAME_CONFIG, JSON.stringify(cfg))
    if (['resume-core-missing', 'resume-lease-core-missing', 'resume-lease-source-remove', 'resume-source-remove-main'].includes(cfg.mode)) {
      const reference = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopPairReference(cfg.root)
      fs.rmSync(path.join(cfg.root, 'releases', reference.selection.core_id), { recursive: true })
    }
    if (['resume-lease-stopping', 'resume-lease-removing', 'resume-lease-completed', 'resume-lease-source-exit', 'resume-lease-source-remove', 'resume-source-remove-main'].includes(cfg.mode)) {
      const fence = path.join(cfg.root, '.desktop-removal.json'), current = JSON.parse(fs.readFileSync(fence, 'utf8'))
      await (await load('desktop-preparation-files.mjs')).privateJson(fence, { ...current, phase: ['resume-lease-source-exit', 'resume-lease-source-remove', 'resume-source-remove-main'].includes(cfg.mode) ? 'removing' : cfg.mode.slice('resume-lease-'.length) }, true)
    }
    prepared = await backend.prepareExistingDesktopRemovalGui({ installRoot: cfg.root, operationId: cfg.operationId })
    if (cfg.mode === 'resume-lease-busy') {
      const locks = await load('cli-lock.mjs'), file = await locks.acquireExistingCliLock(path.join(cfg.root, 'data'), 'fixture-active-other-owner', 0)
      releaseDataLock = () => locks.releaseCliLock(file)
    }
  } else prepared = await (await load('desktop-removal-host.mjs')).prepareDesktopRemovalGui({ installRoot: cfg.root, operationId: cfg.operationId })
  if (cfg.mode === 'resume-source-changed') fs.appendFileSync(path.join(process.resourcesPath, 'desktop-release.json'), ' ')
  if (['changed-copy', 'resume-changed-copy'].includes(cfg.mode)) fs.appendFileSync(path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources/desktop-release.json' : 'resources/desktop-release.json'), ' ')
  const hostArguments = ['publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main'].includes(cfg.mode) ? ['--crabot-removal-host=' + Buffer.from(JSON.stringify({ installRoot: cfg.root, operationId: cfg.operationId, existing: cfg.mode.startsWith('resume-') })).toString('base64url')] : ['--fixture-removal-host']
  child = spawn(prepared.executable, hostArguments, { env: process.env, cwd: cfg.mode === 'publish-inherited-cwd' ? cfg.root : prepared.directory, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const native = require('./bootstrap/scripts/lib/process-identity.cjs'), childIdentity = native.inspectProcess(child.pid)
  const cleanup = cfg.mode === 'publish-cancel' ? (await load('desktop-removal-host-cleanup.mjs')).captureRemovalGuiCleanup(prepared, child) : undefined
  if (cleanup) { const assert = require('node:assert/strict'); await assert.rejects(cleanup(), { code: 'CRABOT_DESKTOP_REMOVAL' }); assert.equal(fs.existsSync(prepared.directory), true) }
  if (sourceExitMode) await send({ handoff: true, host: childIdentity, directory: prepared.directory })
  const { createDesktopRemovalSourceExitVerifier, createExistingRemovalSourceExitVerifier } = await load('desktop-removal-source.mjs')
  const createVerifier = cfg.mode.startsWith('resume-') ? createExistingRemovalSourceExitVerifier : createDesktopRemovalSourceExitVerifier
  const verifySourceExit = createVerifier({ installRoot: cfg.root, prepared, child })
  let exitIntents = 0
  child.on('message', message => {
    if (cfg.mode === 'publish-source-verifier' && message?.kind === 'desktop_removal_source_exit') {
      void (async () => {
        const assert = require('node:assert/strict'), fence = path.join(cfg.root, '.desktop-removal.json')
        const original = fs.readFileSync(fence, 'utf8')
        assert.equal(await verifySourceExit(message), true)
        const wrongChild = createDesktopRemovalSourceExitVerifier({ installRoot: cfg.root, prepared,
          child: { pid: process.pid, connected: true, exitCode: null, signalCode: null } })
        assert.equal(await wrongChild(message), false)
        const wrongExecutable = createDesktopRemovalSourceExitVerifier({ installRoot: cfg.root,
          prepared: { ...prepared, executable: process.execPath }, child })
        assert.equal(await wrongExecutable(message), false)
        for (const changed of [null, {}, { ...message, operation_id: '11111111-1111-4111-8111-111111111111' },
          { ...message, installation_id: '11111111-1111-4111-8111-111111111111' }, { ...message, kind: 'exit' },
          { ...message, path: cfg.root }, { ...message, source_selection: { ...message.source_selection, core_id: 'f'.repeat(64) } }]) {
          assert.equal(await verifySourceExit(changed), false)
        }
        fs.writeFileSync(fence, JSON.stringify({ ...JSON.parse(original), phase: 'preparing' }) + '\n')
        assert.equal(await verifySourceExit(message), false); fs.writeFileSync(fence, original)
        fs.writeFileSync(fence, JSON.stringify({ ...JSON.parse(original), proof_sha256: '0'.repeat(64) }) + '\n')
        assert.equal(await verifySourceExit(message), false); fs.writeFileSync(fence, original)
        const pin = path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources/desktop-release.json' : 'resources/desktop-release.json')
        const bytes = fs.readFileSync(pin); fs.appendFileSync(pin, ' ')
        assert.equal(await verifySourceExit(message), false); fs.writeFileSync(pin, bytes)
        const maintenance = path.join(cfg.root, 'data/desktop-maintenance.json'); fs.writeFileSync(maintenance, '{}')
        assert.equal(await verifySourceExit(message), false); fs.unlinkSync(maintenance)
        const pid = path.join(cfg.root, 'data/mm.pid'); fs.writeFileSync(pid, String(process.pid))
        assert.equal(await verifySourceExit(message), false); fs.unlinkSync(pid)
        const registry = path.join(cfg.root, 'data/module-runtime-registry/records')
        fs.mkdirSync(registry, { recursive: true }); const unknown = path.join(registry, 'unsettled.json'); fs.writeFileSync(unknown, '{}')
        assert.equal(await verifySourceExit(message), false); fs.unlinkSync(unknown)
        assert.equal(await verifySourceExit(message), true)
        child.send({ kind: 'source-verifier-checked', accepted: true })
      })().catch(error => { console.error(error); child.send({ kind: 'source-verifier-checked', accepted: false }) })
      return
    }
    if (!(sourceExitMode || cfg.mode === 'publish-source-disconnect') || message?.kind !== 'desktop_removal_source_exit' || message.operation_id !== cfg.operationId
      || message.installation_id !== prepared.proof.installation_id || JSON.stringify(message.source_selection) !== JSON.stringify(prepared.proof.source_selection)
      || !native.sameProcess(childIdentity, native.inspectProcess(child.pid))) return
    if (cfg.mode === 'publish-source-retry' && ++exitIntents === 1) return
    const requestedAt = performance.now()
    void verifySourceExit(message).then(async accepted => {
      if (!accepted) return
      if (cfg.mode === 'publish-source-late-exit') {
        setTimeout(() => { clearTimeout(timer); app.exit(0) }, Math.max(0, 16000 - (performance.now() - requestedAt)))
        return
      }
      if (cfg.mode === 'resume-lease-source-exit') {
        const assert = require('node:assert/strict'), options = { installRoot: cfg.root, prepared, child }
        assert.equal(await createDesktopRemovalSourceExitVerifier(options)(message), false)
        for (const phase of ['preparing', 'completed']) {
          const wrong = createExistingRemovalSourceExitVerifier({ ...options, prepared: { ...prepared, record: { ...prepared.record, phase } } })
          assert.equal(await wrong(message), false)
        }
      }
      if (cfg.mode === 'publish-source-disconnect') child.disconnect()
      else { clearTimeout(timer); app.exit(0) }
    })
  })
  const exited = once(child, 'exit')
  const result = cfg.mode === 'publish-source-disconnect' ? await exited.then(() => JSON.parse(fs.readFileSync(cfg.resultFile, 'utf8'))) : await Promise.race([new Promise(resolve => child.on('message', result => { if (typeof result?.accepted === 'boolean') resolve(result) })), exited.then(([code, signal]) => { throw new Error('Host exited before a result: ' + code + ':' + signal) })])
  await exited
  if (releaseDataLock) {
    const locks = await load('cli-lock.mjs'), file = await locks.acquireExistingCliLock(cfg.root, 'fixture-confirm-root-release', 0)
    locks.releaseCliLock(file); releaseDataLock(); releaseDataLock = undefined
  }
  if (cleanup) {
    const assert = require('node:assert/strict'), extra = path.join(prepared.directory, 'user-kept')
    fs.writeFileSync(extra, 'unexpected private-root bytes')
    await assert.rejects(cleanup(), { code: 'CRABOT_DESKTOP_REMOVAL' }); assert.equal(fs.readFileSync(extra, 'utf8'), 'unexpected private-root bytes')
    fs.unlinkSync(extra) // Explicit fixture owner action; not product cleanup.
    await cleanup(); result.private_copy_removed = !fs.existsSync(prepared.directory)
  }
  else fs.rmSync(prepared.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  prepared = undefined
  await send(result)
}
main().then(() => { clearTimeout(timer); app.exit(0) }).catch(async error => {
  try {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit') }
    releaseDataLock?.()
    if (prepared) fs.rmSync(prepared.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    await send({ accepted: false, code: 'FIXTURE_FAILED', message: String(error.message).slice(0, 512) })
  } catch {}
  clearTimeout(timer); app.exit(1)
})
