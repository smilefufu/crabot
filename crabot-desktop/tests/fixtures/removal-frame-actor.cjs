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
async function main() {
  await app.whenReady()
  if (host) {
    let result
    try { const { inspectInitialRemovalGuiHost } = await load('desktop-removal-frame.mjs'); const frame = await inspectInitialRemovalGuiHost({ installRoot: cfg.inspectRoot || cfg.root, operationId: cfg.operationId }); result = { accepted: true, frame } }
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
