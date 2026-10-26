// One-shot fixed native authorization. The job owns stop/reference proof and the
// removing commit; authorization readiness alone grants no deletion operation.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { ubuntuDesktopEnvironment } from './ubuntu-process.js'
const require = createRequire(import.meta.url)
const identity = require('./bootstrap/scripts/lib/process-identity.cjs')
const management = require('./bootstrap/scripts/lib/desktop-management.cjs')
const failure = (diagnostic = '') => Object.assign(new Error(
  diagnostic.includes('CRABOT_SANDBOX_NOT_READY:system-policy-in-use') ? '仍有程序使用本应用的系统登记，请关闭相关程序后重试。'
    : diagnostic.includes('CRABOT_SANDBOX_NOT_READY:system-policy-conflict') ? '系统登记已被管理员修改，相关规则已保留，请核对后重试。'
      : '本应用系统登记的授权或移除尚未完成，程序、数据与维护保护已保留。'), { code: 'CRABOT_INSTALL_SYSTEM_AUTHORIZATION', ...(/CRABOT_SANDBOX_NOT_READY:([a-z-]{1,64})/.test(diagnostic)
    ? { stage: diagnostic.match(/CRABOT_SANDBOX_NOT_READY:([a-z-]{1,64})/)![1] } : {}) })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export async function prepareUbuntuRemovalRules(options: { installRoot: string; operationId: string; signal: AbortSignal }) {
  options.signal.throwIfAborted()
  if (process.platform !== 'linux' || process.getuid!() === 0 || process.getuid!() !== process.geteuid!()) throw failure()
  const directory = management.requirePrivateDataRoot(path.dirname(fs.realpathSync(process.execPath)))
  if (path.basename(process.execPath) !== 'node' || fs.realpathSync(process.cwd()) !== directory
    || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))) throw failure()
  const self = identity.inspectProcess(process.pid)
  const { captureStoppedDesktopRemoval } = await import(new URL('./bootstrap/scripts/lib/desktop-removal-context.mjs', import.meta.url).href)
  const { verifyUbuntuRemovalNodeCopy } = await import(new URL('./bootstrap/scripts/lib/desktop-removal-host.mjs', import.meta.url).href)
  const original = await captureStoppedDesktopRemoval(options), before = original.record
  const current = async (removing = false) => {
    const actual = await captureStoppedDesktopRemoval(options)
    await actual.proofCurrent(); actual.assertStopped()
    if (!['stopping', 'removing'].includes(before.phase) || actual.record.phase !== (removing ? 'removing' : before.phase)
      || !same({ ...actual.record, phase: before.phase }, before) || !same(actual.own.record, original.own.record)
      || !identity.sameProcess(self, identity.inspectProcess(process.pid)) || fs.realpathSync(process.cwd()) !== directory
      || directory === actual.own.root || directory.startsWith(actual.own.root + path.sep)) throw failure()
  }
  await current(); await verifyUbuntuRemovalNodeCopy(directory, original.proof); await current()
  options.signal.throwIfAborted()
  const child = spawn('/usr/bin/pkexec', [path.join(directory, 'crabot-sandbox-helper'), '--prepare-removal', original.own.root], {
    cwd: directory, env: ubuntuDesktopEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'],
  })
  let fault: Error | undefined, ready = false, confirmed = false, verified = false, closed = false
  let input = '', diagnostic = '', finish!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void
  let accept!: () => void, reject!: (error: Error) => void
  const readiness = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail })
  void readiness.catch(() => {})
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { finish = resolve })
  const fail = (error: Error = failure(diagnostic)) => { fault ||= error; reject(fault); child.stdin.end() }
  child.stdin.on('error', () => { if (!closed) fail() })
  child.once('error', () => { fail(); finish({ code: null, signal: null }) })
  child.once('close', (code, signal) => { if (!closed && (!ready || !confirmed || !verified || code !== 0 || signal)) fail(); finish({ code, signal }) })
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString('utf8')).slice(-4096) })
  child.stdout.on('data', bytes => {
    input += bytes.toString('utf8')
    if (input.length > 1024) { fail(); return }
    let newline
    while ((newline = input.indexOf('\n')) >= 0) {
      const frame = input.slice(0, newline + 1); input = input.slice(newline + 1)
      if (!ready && frame === 'CRABOT_SANDBOX_REMOVAL_READY\n') { ready = true; accept() }
      else if (ready && confirmed && !verified && frame === 'CRABOT_SANDBOX_VERIFIED\n') verified = true
      else { fail(); return }
    }
  })
  const cancelled = () => fail(new DOMException('Cancelled', 'AbortError'))
  options.signal.addEventListener('abort', cancelled, { once: true })
  // Closing stdin cancels a ready privileged helper before confirmation. The
  // helper has its own bounded wait/parser. A pending OS dialog must actually
  // close before another attempt; no PID signal or guessed termination receipt.
  let closing: Promise<void> | undefined, removing: Promise<void> | undefined
  const close = () => closing ||= (async () => {
    closed = true; child.stdin.end()
    try { await ended } finally { options.signal.removeEventListener('abort', cancelled) }
  })()
  try {
    await readiness
    await current()
    options.signal.throwIfAborted()
    if (fault || child.exitCode !== null || child.signalCode !== null) throw fault || failure(diagnostic)
    return {
      remove: () => removing ||= (async () => {
        await current(true)
        if (closed || fault || !ready || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) throw fault || failure()
        options.signal.throwIfAborted()
        confirmed = true; child.stdin.end('remove\n')
        const result = await ended
        if (fault || result.code !== 0 || result.signal || !verified || input) throw fault || failure()
        await current(true)
      })(),
      close,
    }
  } catch (error) { await close(); throw error }
}
