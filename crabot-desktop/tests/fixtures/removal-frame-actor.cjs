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
  const { acquireExistingCliLock, releaseCliLock } = await load('cli-lock.mjs')
  const originalLink = physical.promises.link, originalUnlink = physical.promises.unlink
  if (cfg.mode === 'publish-lost-reply') physical.promises.link = async (...args) => {
    const result = await originalLink(...args)
    if (args[1] === path.join(cfg.root, '.desktop-removal.json')) throw Object.assign(new Error('fixture lost publication reply'), { code: 'EIO' })
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
  let lease, lost = false, cancelRejected = false, cancelled = false
  try {
    try { lease = await beginInitialDesktopRemoval({ installRoot: cfg.root, operationId: cfg.operationId }) }
    catch (error) { if (cfg.mode !== 'publish-lost-reply' || error.code !== 'EIO') throw error; lost = true }
    const initial = await readDesktopRemovalProof(cfg.root)
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
    if (cfg.mode !== 'publish-close' && cfg.mode !== 'publish-lost-reply') {
      try { await lease.cancel(); cancelled = true; await lease.cancel() }
      catch (error) { if (cfg.mode === 'publish-cancel') throw error; if (cfg.mode === 'publish-cancel-lost' && cancellationReplyLost) { await lease.cancel(); cancelled = true } else cancelRejected = error.code === 'CRABOT_DESKTOP_REMOVAL' }
    }
    const record = removal.readDesktopRemoval(cfg.root)
    return { accepted: true, published: true, cancelled, cancelRejected, lost, retained: Boolean(record), operation_id: record?.operation_id,
      cancellationReplyLost, proofRetained: fs.existsSync(path.join(cfg.root, 'app/removals', cfg.operationId, 'proof.json')) }
  } finally {
    physical.promises.link = originalLink; physical.promises.unlink = originalUnlink
    await lease?.close()
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
    await send(result); return
  }
  prepared = await (await load('desktop-removal-host.mjs')).prepareDesktopRemovalGui({ installRoot: cfg.root, operationId: cfg.operationId })
  if (cfg.mode === 'changed-copy') fs.appendFileSync(path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources/desktop-release.json' : 'resources/desktop-release.json'), ' ')
  child = spawn(prepared.executable, ['--fixture-removal-host'], { env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const exited = once(child, 'exit')
  const result = await Promise.race([once(child, 'message').then(([result]) => result), exited.then(([code, signal]) => { throw new Error('Host exited before a result: ' + code + ':' + signal) })])
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
