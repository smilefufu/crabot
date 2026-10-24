// Protected, packaged test actor only. No product main, business MM or data job.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const cfg = JSON.parse(fs.readFileSync(process.env.CRABOT_REMOVAL_FRAME_CONFIG, 'utf8'))
const host = process.argv.includes('--fixture-removal-host')
const profile = host ? path.resolve(process.resourcesPath, process.platform === 'darwin' ? '../../../..' : '../..', 'frame-profile') : path.join(cfg.root, 'data/desktop-profile')
fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); app.setPath('userData', profile)
const load = name => import(pathToFileURL(path.join(__dirname, 'bootstrap/scripts/lib', name)).href)
let prepared, child
const timer = setTimeout(() => app.exit(2), 60000)
async function send(result) {
  await new Promise((resolve, reject) => process.send(result, error => error ? reject(error) : resolve()))
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
  if (cfg.mode === 'publish-stop-lost') physical.promises.rename = async (...args) => {
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
  let lease, lost = false, cancelRejected = false, cancelled = false, stopApplied = false, stopRejected = false, sourceExited = false, sourceExitRejected = false
  try {
    try { lease = await beginInitialDesktopRemoval({ installRoot: cfg.root, operationId: cfg.operationId }) }
    catch (error) { if (cfg.mode !== 'publish-lost-reply' || error.code !== 'EIO') throw error; lost = true }
    const initial = await readDesktopRemovalProof(cfg.root)
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
      if (cfg.mode === 'publish-source-exit') { await lease.exitSource(); sourceExited = true }
      else { await assert.rejects(lease.exitSource()); sourceExitRejected = true }
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
    if (!['publish-close', 'publish-lost-reply', 'publish-source-ignore', 'publish-source-disconnect'].includes(cfg.mode)) {
      try { await lease.cancel(); cancelled = true; await lease.cancel() }
      catch (error) { if (['publish-cancel', 'publish-stop', 'publish-source-exit', 'publish-source-verifier'].includes(cfg.mode)) throw error; if (cfg.mode === 'publish-cancel-lost' && cancellationReplyLost) { await lease.cancel(); cancelled = true } else cancelRejected = error.code === 'CRABOT_DESKTOP_REMOVAL' }
    }
    const record = removal.readDesktopRemoval(cfg.root)
    return { accepted: true, published: true, cancelled, cancelRejected, lost, retained: Boolean(record), operation_id: record?.operation_id,
      cancellationReplyLost, stopApplied, stopRejected, sourceExited, sourceExitRejected, phase: record?.phase, proofRetained: fs.existsSync(path.join(cfg.root, 'app/removals', cfg.operationId, 'proof.json')) }
  } finally {
    physical.promises.link = originalLink; physical.promises.unlink = originalUnlink; physical.promises.rename = originalRename
    await lease?.close()
    if (cfg.mode === 'publish-stop') assert.throws(() => lease.stop(), { code: 'CRABOT_DESKTOP_REMOVAL' })
    for (const directory of [cfg.root, path.join(cfg.root, 'data')]) {
      const lock = await acquireExistingCliLock(directory, 'fixture-confirm-release', 0); releaseCliLock(lock)
    }
  }
}
async function main() {
  await app.whenReady()
  if (host) {
    let result
    try { if (cfg.mode.startsWith('publish-')) { result = await publication(); } else { const { inspectInitialRemovalGuiHost } = await load('desktop-removal-frame.mjs'); const frame = await inspectInitialRemovalGuiHost({ installRoot: cfg.inspectRoot || cfg.root, operationId: cfg.operationId }); result = { accepted: true, frame } } }
    catch (error) { result = { accepted: false, code: error.code, stage: error.stage, message: String(error.message).slice(0, 256) } }
    if (['publish-source-exit', 'publish-source-disconnect'].includes(cfg.mode)) {
      fs.writeFileSync(cfg.resultFile, JSON.stringify(result)); if (!result.accepted && process.connected) await send(result)
    }
    else await send(result)
    return
  }
  prepared = await (await load('desktop-removal-host.mjs')).prepareDesktopRemovalGui({ installRoot: cfg.root, operationId: cfg.operationId })
  if (cfg.mode === 'changed-copy') fs.appendFileSync(path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources/desktop-release.json' : 'resources/desktop-release.json'), ' ')
  child = spawn(prepared.executable, ['--fixture-removal-host'], { env: process.env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const native = require('./bootstrap/scripts/lib/process-identity.cjs'), childIdentity = native.inspectProcess(child.pid)
  if (cfg.mode === 'publish-source-exit') await send({ handoff: true, host: childIdentity, directory: prepared.directory })
  const { createDesktopRemovalSourceExitVerifier } = await load('desktop-removal-source.mjs')
  const verifySourceExit = createDesktopRemovalSourceExitVerifier({ installRoot: cfg.root, prepared, child })
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
    if (!['publish-source-exit', 'publish-source-disconnect'].includes(cfg.mode) || message?.kind !== 'desktop_removal_source_exit' || message.operation_id !== cfg.operationId
      || message.installation_id !== prepared.proof.installation_id || JSON.stringify(message.source_selection) !== JSON.stringify(prepared.proof.source_selection)
      || !native.sameProcess(childIdentity, native.inspectProcess(child.pid))) return
    void verifySourceExit(message).then(accepted => {
      if (!accepted) return
      if (cfg.mode === 'publish-source-disconnect') child.disconnect()
      else { clearTimeout(timer); app.exit(0) }
    })
  })
  const exited = once(child, 'exit')
  const result = cfg.mode === 'publish-source-disconnect' ? await exited.then(() => JSON.parse(fs.readFileSync(cfg.resultFile, 'utf8'))) : await Promise.race([new Promise(resolve => child.on('message', result => { if (typeof result?.accepted === 'boolean') resolve(result) })), exited.then(([code, signal]) => { throw new Error('Host exited before a result: ' + code + ':' + signal) })])
  await exited
  fs.rmSync(prepared.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); prepared = undefined
  await send(result)
}
main().then(() => { clearTimeout(timer); app.exit(0) }).catch(async error => {
  try {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit') }
    if (prepared) fs.rmSync(prepared.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    await send({ accepted: false, code: 'FIXTURE_FAILED', message: String(error.message).slice(0, 512) })
  } catch {}
  clearTimeout(timer); app.exit(1)
})
