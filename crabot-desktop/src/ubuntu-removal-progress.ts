// Display transport only. The verified private Node owner retains all lifecycle
// and file-operation authority; this component cannot stop or remove Crabot.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { OperationProgressSchema } from './operation-progress.js'
import { ubuntuDesktopEnvironment } from './ubuntu-process.js'
const require = createRequire(import.meta.url)
const identity = require('./bootstrap/scripts/lib/process-identity.cjs')
const management = require('./bootstrap/scripts/lib/desktop-management.cjs')
const { probeKnownProcessExit } = require('./bootstrap/scripts/lib/known-process-exit.cjs')
type FrontendFile = { type: 'file'; size: number; sha256: string; mode: number }
const dialogChoices = { 'retry-cancel': ['retry', 'cancel', 'close'], 'retry-repair': ['retry', 'repair', 'close'], completed: ['close', 'reveal'], cancelled: ['close'], repair: ['close'] } as const
export type RemovalDialogKind = keyof typeof dialogChoices
export type RemovalDialogChoice = 'retry' | 'cancel' | 'repair' | 'close' | 'reveal'
const failure = () => Object.assign(new Error('独立维护界面无法核验或连接已中断，操作结果尚未确认。'), { code: 'CRABOT_DESKTOP_REMOVAL' })
const generation = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')

export async function createUbuntuRemovalProgressWindow(options: { directory: string; frontend: FrontendFile; abort: AbortController }) {
  options.abort.signal.throwIfAborted()
  if (process.platform === 'win32') throw failure()
  const directory = management.requirePrivateDataRoot(path.resolve(options.directory))
  const initialDirectory = fs.lstatSync(directory, { bigint: true })
  const directoryId = [initialDirectory.dev, initialDirectory.ino, initialDirectory.mode, initialDirectory.uid, initialDirectory.gid].join(':')
  const executable = path.join(directory, 'crabot-maintenance'), expected = options.frontend
  if (!expected || Object.keys(expected).sort().join(',') !== 'mode,sha256,size,type' || expected.type !== 'file'
    || !Number.isSafeInteger(expected.size) || expected.size < 20 || expected.size > 10 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isInteger(expected.mode) || expected.mode < 0 || expected.mode > 0o777
    || !(expected.mode & 0o111) || expected.mode & 0o022) throw failure()
  const fileId = generation(fs.lstatSync(executable, { bigint: true }))
  const verify = () => {
    const parent = fs.lstatSync(directory, { bigint: true }), stat = fs.lstatSync(executable, { bigint: true })
    if (management.requirePrivateDataRoot(directory) !== directory || [parent.dev, parent.ino, parent.mode, parent.uid, parent.gid].join(':') !== directoryId
      || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== BigInt(expected.mode)
      || stat.size !== BigInt(expected.size) || generation(stat) !== fileId) throw failure()
    const fd = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      if (generation(fs.fstatSync(fd, { bigint: true })) !== fileId) throw failure()
      const bytes = Buffer.alloc(expected.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (!count) throw failure()
        offset += count
      }
      if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) || generation(fs.fstatSync(fd, { bigint: true })) !== fileId
        || createHash('sha256').update(bytes).digest('hex') !== expected.sha256
        || generation(fs.fstatSync(fd, { bigint: true })) !== fileId || generation(fs.lstatSync(executable, { bigint: true })) !== fileId) throw failure()
    } finally { fs.closeSync(fd) }
  }
  verify(); options.abort.signal.throwIfAborted()
  const child = spawn(executable, [], { cwd: directory, env: ubuntuDesktopEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'] })
  let peer: { pid: number; parent: number; owner: string; started: string; executable: string } | undefined
  let ready = false, closing = false, stopped = false, cancellable = false, fault: Error | undefined
  let input = Buffer.alloc(0), diagnostic = ''
  let pendingDialog: { kind: RemovalDialogKind; resolve: (choice: RemovalDialogChoice) => void; reject: (error: Error) => void } | undefined
  let acceptReady!: () => void, rejectReady!: (error: Error) => void, closePromise: Promise<void> | undefined
  const readiness = new Promise<void>((resolve, reject) => { acceptReady = resolve; rejectReady = reject })
  // Rejections are still observed by the caller; startup cleanup can await close.
  void readiness.catch(() => {})
  const fail = (error = failure()) => { fault ||= error; cancellable = false; rejectReady(fault); pendingDialog?.reject(fault); pendingDialog = undefined; options.abort.abort(fault) }
  const current = () => {
    if (fault || !ready || closing || stopped || !peer || !identity.sameProcess(peer, identity.inspectProcess(child.pid))) throw fault || failure()
    verify()
  }
  const ended = new Promise<void>(resolve => {
    child.once('error', () => { fail(); resolve() })
    child.once('close', () => { stopped = true; if (!closing) fail(); resolve() })
  })
  child.once('spawn', () => {
    try {
      peer = identity.inspectProcess(child.pid)
      if (!peer || peer.parent !== process.pid || peer.owner !== identity.inspectProcess(process.pid)?.owner || path.resolve(peer.executable) !== executable) fail()
    } catch { fail() }
  })
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString('utf8')).slice(-8192) })
  child.stdin.on('error', () => { if (!closing) fail() })
  child.stdout.on('data', (bytes: Buffer) => {
    if (closing || fault) return
    for (const byte of bytes) {
      if (input.length >= 256) { fail(); return }
      input = Buffer.concat([input, Buffer.from([byte])])
      if (byte !== 10) continue
      const frame = input; input = Buffer.alloc(0)
      if (frame.equals(Buffer.from('{"event":"ready"}\n')) && !ready) {
        try {
          verify()
          if (!peer || !identity.sameProcess(peer, identity.inspectProcess(child.pid))) throw failure()
          ready = true; acceptReady()
        } catch { fail() }
      } else if (ready && pendingDialog && /^\{"choice":"(?:retry|cancel|repair|close|reveal)"\}\n$/.test(frame.toString('utf8'))) {
        try { current() } catch { fail(); return }
        const choice = JSON.parse(frame.toString('utf8')).choice as RemovalDialogChoice
        if (!(dialogChoices[pendingDialog.kind] as readonly string[]).includes(choice)) { fail(); return }
        const pending = pendingDialog; pendingDialog = undefined; pending.resolve(choice)
      } else if (frame.equals(Buffer.from('{"action":"cancel"}\n')) && ready) {
        try { current() } catch { fail(); return }
        if (cancellable && !options.abort.signal.aborted) { cancellable = false; options.abort.abort() }
      } else { fail(); return }
    }
  })
  const waitExit = async (timeout: number) => {
    let timer: NodeJS.Timeout | undefined
    try { return await Promise.race([ended.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeout) })]) }
    finally { clearTimeout(timer) }
  }
  const close = () => closePromise ||= (async () => {
    closing = true; cancellable = false
    pendingDialog?.reject(failure()); pendingDialog = undefined
    if (!stopped && child.stdin.writable) child.stdin.end('{"type":"close"}\n')
    if (await waitExit(3000)) return
    // Only this exact child generation may be terminated. Unknowns retain the
    // private host for diagnosis; never signal by name, process group or port.
    if (!peer) throw failure()
    const actual = identity.inspectProcess(peer.pid)
    if (identity.sameProcess(peer, actual)) identity.terminateKnownProcess(peer)
    else if (probeKnownProcessExit([peer]).state !== 'stopped') throw failure()
    if (!await waitExit(3000)) throw failure()
  })()
  const abortStartup = () => { if (!ready) rejectReady(options.abort.signal.reason) }
  options.abort.signal.addEventListener('abort', abortStartup, { once: true })
  const deadline = setTimeout(() => fail(), 10000)
  try {
    if (options.abort.signal.aborted) options.abort.signal.throwIfAborted()
    await readiness; current()
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], '维护界面未能正常准备和退出，保留诊断。') }
    throw error
  } finally { clearTimeout(deadline); options.abort.signal.removeEventListener('abort', abortStartup) }
  return {
    update(message: string, allowCancel = true) {
      const progress = OperationProgressSchema.parse({ message, cancellable: allowCancel && !options.abort.signal.aborted })
      current(); if (pendingDialog) throw failure(); cancellable = progress.cancellable
      if (!child.stdin.write(JSON.stringify({ type: 'progress', ...progress }) + '\n')) { fail(); throw fault || failure() }
    },
    choose(kind: RemovalDialogKind): Promise<RemovalDialogChoice> {
      current()
      if (!Object.hasOwn(dialogChoices, kind) || pendingDialog) throw failure()
      cancellable = false
      return new Promise((resolve, reject) => {
        pendingDialog = { kind, resolve, reject }
        if (!child.stdin.write(JSON.stringify({ type: 'dialog', kind }) + '\n')) fail()
      }).then(choice => { current(); return choice as RemovalDialogChoice })
    },
    assertReady: current,
    close,
    diagnostic: () => diagnostic,
  }
}
