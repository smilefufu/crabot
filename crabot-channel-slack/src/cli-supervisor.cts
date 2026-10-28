// One IPC-owned supervisor per CLI invocation. Losing Admin also stops the CLI tree.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const project = process.argv[2]
const stateFile = path.join(project, 'process-state.json')
let child: ChildProcess | undefined
let stopping: Promise<void> | undefined
let closed: Promise<void> = Promise.resolve()
let exited = false, finishing = false, failed = false
let output = '', exitCode: number | null = null
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function stop(): Promise<void> {
  if (stopping) return stopping
  stopping = (async () => {
    if (!child?.pid) return
    const pid = child.pid
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(project, 'stop'), '', { mode: 0o600 })
      const deadline = Date.now() + 15000
      while (!exited && Date.now() < deadline) await sleep(100)
      // The live ChildProcess is owned here; never load a historical PID to taskkill.
      if (!exited) await new Promise<void>((resolve, reject) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolve()))
      return
    }
    try { process.kill(-pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try { process.kill(-pid, 0) } catch { return }
      await sleep(100)
    }
    try { process.kill(-pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    const forceDeadline = Date.now() + 5000
    while (Date.now() < forceDeadline) {
      try { process.kill(-pid, 0) } catch { return }
      await sleep(100)
    }
    throw new Error('CLI tree did not exit')
  })()
  return stopping
}
function finishStop() {
  if (finishing) return
  finishing = true
  void (async () => {
    try {
      await stop()
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CLI pipes did not close')), 5000) })]) }
      finally { if (timer) clearTimeout(timer) }
      fs.rmSync(stateFile, { force: true })
      if (process.connected) process.send?.({ type: failed ? 'failed' : 'exit', code: exitCode, output }, () => process.exit(failed ? 2 : 0))
      else process.exit(0)
    } catch { process.exit(2) }
  })()
}
process.on('disconnect', finishStop)
process.on('SIGTERM', finishStop)
process.on('SIGINT', finishStop)
process.on('message', (message: { type: string; executable: string; args: string[]; cwd: string }) => {
  if (message.type === 'stop') { finishStop(); return }
  if (message.type !== 'start' || child || finishing) return
  fs.rmSync(path.join(project, 'stop'), { force: true })
  // Slack CLI probes its terminal before parsing flags; Windows needs normal console startup.
  child = spawn(message.executable, message.args, { cwd: message.cwd, env: process.env, detached: process.platform !== 'win32', windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('spawn', () => fs.writeFileSync(stateFile, JSON.stringify({ cli_pid: child!.pid, supervisor_pid: process.pid }), { mode: 0o600 }))
  closed = new Promise(resolve => child!.once('close', code => { exitCode = code; resolve(); finishStop() }))
  const capture = (chunk: Buffer) => {
    if (output.length + chunk.length > 1024 * 1024) { failed = true; finishStop(); return }
    output += chunk.toString('utf8')
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  child.on('error', () => { failed = true; finishStop() })
  child.on('exit', () => { exited = true })
})
