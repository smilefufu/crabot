const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { loadRuntime } = require('./computer-use-runtime.cjs')
const run = promisify(execFile)

function cancelled(signal) { if (signal?.aborted) throw new Error('COMPUTER_USE_SETUP_CANCELLED') }
const pause = ms => new Promise(done => setTimeout(done, ms))

function runtimeAt(root) {
  try { return loadRuntime(root) }
  catch (error) {
    const code = error.message?.match(/^(COMPUTER_USE_[A-Z_]+)(?::|$)/)?.[1]
    throw new Error(code ?? (error.code === 'ENOENT' ? 'COMPUTER_USE_RUNTIME_MISSING' : 'COMPUTER_USE_RUNTIME_UNAVAILABLE'))
  }
}

async function describeHost() {
  let session = 'unknown'
  try {
    if (process.platform === 'darwin') session = (await fs.stat('/dev/console')).uid === process.getuid() ? 'active' : 'unavailable'
    else if (process.platform === 'linux') session = process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? 'active' : 'unavailable'
    else if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Diagnostics.Process]::GetCurrentProcess().SessionId'], { timeout: 5000 })
      session = /^\d+$/.test(stdout.trim()) && Number(stdout.trim()) > 0 ? 'active' : 'unavailable'
    } else session = 'unavailable'
  } catch { /* Unknown is not permission missing or a healthy desktop. */ }
  return { platform: process.platform, hostname: os.hostname(), session }
}

async function appRuntime(root, signal) {
  cancelled(signal)
  const runtime = runtimeAt(root)
  if (!runtime.app) throw new Error('COMPUTER_USE_PLATFORM_UNSUPPORTED')
  await run('codesign', ['--verify', '--deep', '--strict', runtime.app], { timeout: 5000, signal, maxBuffer: 65536 })
    .catch(() => { cancelled(signal); throw new Error('COMPUTER_USE_APP_SIGNATURE_INVALID') })
  return runtime
}

async function helperProcesses(app, marker) {
  const { stdout } = await run('ps', ['-axo', 'pid=,command='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 })
  const exactArgument = value => new RegExp(`(?:^|\\s)${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`)
  const executable = exactArgument(path.join(app, 'Contents/MacOS/cua-driver'))
  const resultFile = exactArgument(`--result-file ${marker}`)
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    return match && executable.test(match[2]) && resultFile.test(match[2])
      && /(?:^|\s)(?:__permissions-host-request|--cua-internal-permission-probe)(?=\s|$)/.test(match[2]) ? [Number(match[1])] : []
  })
}

async function stopHelpers(app, marker) {
  for (const pid of await helperProcesses(app, marker)) {
    const current = await helperProcesses(app, marker)
    if (current.includes(pid)) {
      try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  for (let i = 0; i < 20; i++) {
    if (!(await helperProcesses(app, marker)).length) return
    await pause(50)
  }
  for (const pid of await helperProcesses(app, marker)) {
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  for (let i = 0; i < 20; i++) {
    if (!(await helperProcesses(app, marker)).length) return
    await pause(50)
  }
  throw new Error('COMPUTER_USE_HELPER_STOP_UNCONFIRMED')
}

async function acquireHelper(app, marker, signal) {
  const lock = path.join(os.tmpdir(), `crabot-cua-permission-helper-${process.getuid()}.lock`)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    cancelled(signal)
    try {
      await fs.mkdir(lock, { mode: 0o700 })
      try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ owner_pid: process.pid, app, marker }), { mode: 0o600 }) }
      catch (writeError) { await fs.rm(lock, { recursive: true }); throw writeError }
      return () => fs.rm(lock, { recursive: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const stat = await fs.lstat(lock)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) throw new Error('COMPUTER_USE_HELPER_STOP_UNCONFIRMED')
      let previous
      try { previous = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')) } catch { await pause(100); continue }
      if (!Number.isInteger(previous.owner_pid) || previous.owner_pid <= 0) throw new Error('COMPUTER_USE_HELPER_STOP_UNCONFIRMED')
      try { process.kill(previous.owner_pid, 0); await pause(100); continue }
      catch (check) { if (check.code !== 'ESRCH') throw new Error('COMPUTER_USE_HELPER_STOP_UNCONFIRMED') }
      if (typeof previous.app !== 'string' || !previous.app.endsWith('/CuaDriver.app')
        || path.dirname(previous.marker ?? '') !== path.resolve(os.tmpdir())
        || !/^cua-driver-permissions-crabot-\d+-[0-9a-f-]+\.json$/.test(path.basename(previous.marker ?? ''))) throw new Error('COMPUTER_USE_HELPER_STOP_UNCONFIRMED')
      const reclaim = path.join(lock, 'reclaim')
      try { await fs.mkdir(reclaim) } catch (claim) { if (claim.code === 'EEXIST' || claim.code === 'ENOENT') { await pause(100); continue }; throw claim }
      let removed = false
      try {
        const latest = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'))
        if (latest.owner_pid !== previous.owner_pid || latest.marker !== previous.marker) continue
        await stopHelpers(previous.app, previous.marker)
        await fs.rm(previous.marker, { force: true })
        await fs.rm(previous.marker + '.stderr', { force: true })
        await fs.rm(lock, { recursive: true }); removed = true
      } finally { if (!removed) await fs.rm(reclaim, { recursive: true, force: true }) }
    }
  }
  throw new Error('COMPUTER_USE_HELPER_BUSY')
}

/** Finite LaunchServices probes only. Never discovers or starts a desktop daemon. */
async function invoke(root, request, { signal, probeCapture = false } = {}) {
  const runtime = await appRuntime(root, signal)
  const resultFile = path.join(os.tmpdir(), `cua-driver-permissions-crabot-${process.pid}-${randomUUID()}.json`)
  const stderrFile = resultFile + '.stderr'
  const release = await acquireHelper(runtime.app, resultFile, signal)
  let launched = false
  try {
    await fs.writeFile(resultFile, '', { flag: 'wx', mode: 0o600 })
    await fs.writeFile(stderrFile, '', { flag: 'wx', mode: 0o600 })
    cancelled(signal)
    const args = ['-n', '-g', '--env', 'CUA_TELEMETRY=0', '--env', 'CUA_DRIVER_RS_TELEMETRY_ENABLED=0', '--env', `TMPDIR=${os.tmpdir()}`]
    if (!request) args.push('--stdout', resultFile)
    args.push('--stderr', stderrFile, runtime.app, '--args', request ? '__permissions-host-request' : '--cua-internal-permission-probe', '--result-file', resultFile)
    if (probeCapture) args.push('--probe-direct-capture')
    launched = true
    await run('open', args, { timeout: 5000, signal, maxBuffer: 65536 })
      .catch(() => { cancelled(signal); throw new Error('COMPUTER_USE_HELPER_LAUNCH_FAILED') })
    const deadline = Date.now() + (request ? 15000 : 5000)
    while (Date.now() < deadline) {
      cancelled(signal)
      const file = await fs.open(resultFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      let text
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o777) !== 0o600) throw new Error('COMPUTER_USE_HELPER_RESULT_INVALID')
        text = await file.readFile('utf8')
      } finally { await file.close() }
      if (text) {
        const result = JSON.parse(text)
        const data = request ? result.structuredContent : result
        if (typeof data?.accessibility !== 'boolean' || typeof data?.screen_recording !== 'boolean') throw new Error('COMPUTER_USE_HELPER_RESULT_INVALID')
        if (request && (data.source?.attribution !== 'driver-daemon' || data.source?.bundle_id !== 'com.trycua.driver'
          || data.source?.executable !== await fs.realpath(path.join(runtime.app, 'Contents/MacOS/cua-driver')))) throw new Error('COMPUTER_USE_HELPER_IDENTITY_INVALID')
        return { accessibility: data.accessibility, screen_recording: data.screen_recording,
          ...(request && probeCapture ? { capturable: !result.isError && data.screen_recording_capturable === true && data.direct_capture_status === 'ready' } : {}) }
      }
      await pause(100)
    }
    throw new Error('COMPUTER_USE_HELPER_TIMEOUT')
  } finally {
    if (launched) await stopHelpers(runtime.app, resultFile)
    await fs.rm(resultFile, { force: true })
    await fs.rm(stderrFile, { force: true })
    await release()
  }
}

async function revealApp(root) {
  const runtime = await appRuntime(root)
  await run('open', ['-R', runtime.app], { timeout: 5000, maxBuffer: 65536 })
}
async function openSettings(root, permission, { signal } = {}) {
  await appRuntime(root, signal)
  cancelled(signal)
  const panes = { accessibility: 'Privacy_Accessibility', screen_recording: 'Privacy_ScreenCapture' }
  if (!panes[permission]) throw new Error('COMPUTER_USE_HELPER_RESULT_INVALID')
  await run('open', [`x-apple.systempreferences:com.apple.preference.security?${panes[permission]}`], { timeout: 5000, signal, maxBuffer: 65536 })
}
module.exports = { describeHost, readPermissions: (root, options) => invoke(root, false, options),
  requestPermissions: (root, options) => invoke(root, true, options), revealApp, openSettings, appPath: root => runtimeAt(root).app }
