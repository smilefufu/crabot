// Protected, packaged test actor only. No product main, business MM or data job.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const cfg = JSON.parse(fs.readFileSync(process.env.CRABOT_REMOVAL_FRAME_CONFIG, 'utf8'))
const host = process.argv.includes('--fixture-removal-host')
const sourceExitMode = ['publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'resume-lease-source-exit', 'publish-source-remove', 'publish-source-remove-retry', 'resume-lease-source-remove'].includes(cfg.mode)
const profile = host ? path.resolve(process.resourcesPath, process.platform === 'darwin' ? '../../../..' : '../..', 'frame-profile') : path.join(cfg.root, 'data/desktop-profile')
fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); app.setPath('userData', profile)
const load = name => import(pathToFileURL(path.join(__dirname, 'bootstrap/scripts/lib', name)).href)
let prepared, child, releaseDataLock
const timer = setTimeout(() => app.exit(2), 60000)
async function send(result) {
  await new Promise((resolve, reject) => process.send(result, error => error ? reject(error) : resolve()))
}
async function assertIndependentHostLocation() {
  const assert = require('node:assert/strict'), native = require('./bootstrap/scripts/lib/process-identity.cjs')
  assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(path.dirname(profile)))
  if (process.platform === 'darwin') {
    const reference = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopPairReference(cfg.root)
    const observed = await native.inspectProgramReferences({ roots: [path.join(cfg.root, 'app/releases', reference.selection.gui_id),
      path.join(cfg.root, 'releases', reference.selection.core_id)], files: [] })
    assert.equal(observed.incomplete, false)
    assert.equal(observed.unknown_pids.includes(process.pid), false)
    assert.equal(observed.processes.some(value => value.pid === process.pid), false)
  }
}
async function removePrograms(lease) {
  const assert = require('node:assert/strict'), native = require('./bootstrap/scripts/lib/process-identity.cjs')
  const physical = require('./bootstrap/scripts/lib/physical-fs.cjs')
  const original = native.inspectProgramReferences, rename = physical.promises.rename, unlink = physical.unlinkSync
  const fence = path.join(cfg.root, '.desktop-removal.json'), read = () => JSON.parse(fs.readFileSync(fence))
  const clear = async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] })
  // Only resource answers are controlled here. Parent/source identities, OS
  // exits, locks, hashes, file mutations and the private host remain actual.
  native.inspectProgramReferences = clear
  try {
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
      await assert.rejects(lease.retryRemovePrograms(), { code: 'CRABOT_CORE_INTEGRITY' }); fs.writeFileSync(pin, bytes)
      native.inspectProgramReferences = async () => { fs.writeFileSync(fence, JSON.stringify({ ...read(), phase: 'completed' }) + '\n'); return clear() }
      await assert.rejects(lease.retryRemovePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' }); fs.writeFileSync(fence, before)
      native.inspectProgramReferences = clear
      physical.promises.rename = async (...args) => { if (args[1] === fence) throw Object.assign(new Error('fixture removing not committed'), { code: 'EIO' }); return rename(...args) }
      await assert.rejects(lease.retryRemovePrograms(), { code: 'EIO' }); assert.equal(read().phase, 'stopping')
      physical.promises.rename = async (...args) => {
        const result = await rename(...args)
        if (args[1] === fence && read().phase === 'removing') throw Object.assign(new Error('fixture lost removing reply'), { code: 'EIO' })
        return result
      }
      await assert.rejects(lease.retryRemovePrograms(), { code: 'EIO' }); physical.promises.rename = rename
      assert.equal(read().phase, 'removing'); assert.ok(fs.existsSync(path.join(core, 'program.mjs')))
      await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      const removing = fs.readFileSync(fence)
      fs.writeFileSync(fence, JSON.stringify({ ...read(), phase: 'completed' }) + '\n')
      await assert.rejects(lease.retryRemovePrograms(), { code: 'CRABOT_DESKTOP_REMOVAL' }); fs.writeFileSync(fence, removing)
      const gui = path.join(cfg.root, 'app/releases', read().source_selection.gui_id)
      let deleted
      physical.unlinkSync = file => {
        const result = unlink(file)
        if (!deleted && file.startsWith(gui + path.sep)) { deleted = file; throw Object.assign(new Error('fixture lost file removal reply'), { code: 'EIO' }) }
        return result
      }
      await assert.rejects(lease.retryRemovePrograms(), { code: 'EIO' }); physical.unlinkSync = unlink
      assert.ok(deleted); assert.equal(fs.existsSync(deleted), false); assert.equal(read().phase, 'removing')
      const unknown = path.join(core, 'user-kept.txt'); fs.writeFileSync(unknown, 'custom program directory file')
      const retry = lease.retryRemovePrograms(); assert.equal(retry, lease.retryRemovePrograms()); assert.equal(retry, lease.removePrograms())
      assert.throws(() => lease.close(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      const partial = await retry
      assert.ok(partial.removed.length > 0); assert.equal(partial.retained.length, 1)
      assert.equal(fs.readFileSync(unknown, 'utf8'), 'custom program directory file'); assert.equal(await lease.removePrograms(), partial)
      await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
      fs.unlinkSync(unknown) // Explicit fixture-user action; never product cleanup.
    }
    const first = cfg.mode === 'publish-source-remove-retry' ? lease.retryRemovePrograms() : lease.removePrograms()
    assert.equal(first, lease.removePrograms())
    assert.throws(() => lease.close(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    await assert.rejects(lease.cancel(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    const result = await first
    assert.equal((await lease.current()).phase, 'removing')
    if (cfg.mode !== 'publish-source-remove-retry') assert.ok(result.removed.length > 0)
    assert.equal(result.retained.length, 0)
    assert.equal(await lease.removePrograms(), result); assert.equal(await lease.retryRemovePrograms(), result)
    assert.equal(fs.readFileSync(path.join(cfg.root, 'data/preserved-user-file'), 'utf8'), 'user bytes')
    return { programsRemoved: true, controlledResourceObservation: true, removalRetried: cfg.mode === 'publish-source-remove-retry' }
  } finally { native.inspectProgramReferences = original; physical.promises.rename = rename; physical.unlinkSync = unlink }
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
    if (!['publish-close', 'publish-lost-reply', 'publish-source-ignore', 'publish-source-disconnect', 'publish-source-remove', 'publish-source-remove-retry'].includes(cfg.mode)) {
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
    try { if (cfg.mode.startsWith('resume-')) {
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
  if (cfg.mode.startsWith('resume-')) {
    const backend = await load('desktop-removal-host.mjs'), assert = require('node:assert/strict')
    prepared = await backend.prepareDesktopRemovalGui({ installRoot: cfg.root, operationId: cfg.operationId })
    fs.writeFileSync(process.env.CRABOT_REMOVAL_FRAME_CONFIG, JSON.stringify({ ...cfg, mode: 'publish-close' }))
    child = spawn(prepared.executable, ['--fixture-removal-host'], { env: process.env, cwd: prepared.directory, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const firstExit = once(child, 'exit'), [first] = await once(child, 'message')
    assert.equal(first.accepted, true); assert.equal(first.published, true); assert.equal((await firstExit)[0], 0)
    fs.rmSync(prepared.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); prepared = undefined
    fs.writeFileSync(process.env.CRABOT_REMOVAL_FRAME_CONFIG, JSON.stringify(cfg))
    if (['resume-core-missing', 'resume-lease-core-missing', 'resume-lease-source-remove'].includes(cfg.mode)) {
      const reference = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopPairReference(cfg.root)
      fs.rmSync(path.join(cfg.root, 'releases', reference.selection.core_id), { recursive: true })
    }
    if (['resume-lease-stopping', 'resume-lease-removing', 'resume-lease-completed', 'resume-lease-source-exit', 'resume-lease-source-remove'].includes(cfg.mode)) {
      const fence = path.join(cfg.root, '.desktop-removal.json'), current = JSON.parse(fs.readFileSync(fence, 'utf8'))
      await (await load('desktop-preparation-files.mjs')).privateJson(fence, { ...current, phase: ['resume-lease-source-exit', 'resume-lease-source-remove'].includes(cfg.mode) ? 'removing' : cfg.mode.slice('resume-lease-'.length) }, true)
    }
    prepared = await backend.prepareExistingDesktopRemovalGui({ installRoot: cfg.root, operationId: cfg.operationId })
    if (cfg.mode === 'resume-lease-busy') {
      const locks = await load('cli-lock.mjs'), file = await locks.acquireExistingCliLock(path.join(cfg.root, 'data'), 'fixture-active-other-owner', 0)
      releaseDataLock = () => locks.releaseCliLock(file)
    }
  } else prepared = await (await load('desktop-removal-host.mjs')).prepareDesktopRemovalGui({ installRoot: cfg.root, operationId: cfg.operationId })
  if (cfg.mode === 'resume-source-changed') fs.appendFileSync(path.join(process.resourcesPath, 'desktop-release.json'), ' ')
  if (['changed-copy', 'resume-changed-copy'].includes(cfg.mode)) fs.appendFileSync(path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources/desktop-release.json' : 'resources/desktop-release.json'), ' ')
  child = spawn(prepared.executable, ['--fixture-removal-host'], { env: process.env, cwd: cfg.mode === 'publish-inherited-cwd' ? cfg.root : prepared.directory, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const native = require('./bootstrap/scripts/lib/process-identity.cjs'), childIdentity = native.inspectProcess(child.pid)
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
  fs.rmSync(prepared.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); prepared = undefined
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
