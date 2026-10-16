import { spawn } from 'node:child_process'

// detached 创建专属进程组；只能终止本次准备命令拥有的进程。
export function runBounded(command, args, { cwd, env = process.env, timeout = 20 * 60_000, signal, shell = false, captureError = false } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, shell, stdio: captureError ? ['inherit', 'inherit', 'pipe'] : 'inherit', detached: process.platform !== 'win32' })
    let stderr = ''
    if (captureError) child.stderr.on('data', data => { process.stderr.write(data); stderr = (stderr + data).slice(-65536) })
    let reason
    let forceTimer
    const killOwned = (force) => {
      if (!child.pid) return
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], { stdio: 'ignore' })
      else { try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch {} }
    }
    function terminate(message, code) {
      reason ??= Object.assign(new Error(message), code ? { code } : {})
      killOwned(false)
      forceTimer ??= setTimeout(() => killOwned(true), 2000)
    }
    const timer = setTimeout(() => terminate(`${command}: preparation timed out`), timeout)
    const abort = () => terminate(`${command}: preparation cancelled`, 'CRABOT_PREPARATION_CANCELLED')
    process.once('SIGINT', abort)
    process.once('SIGTERM', abort)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.on('error', err => { reason = err })
    child.on('close', code => {
      if (reason || code !== 0) killOwned(true)
      clearTimeout(timer); clearTimeout(forceTimer)
      signal?.removeEventListener('abort', abort)
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
      if (reason || code !== 0) {
        const error = reason ?? new Error(`${command} exited with code ${code}`)
        if (captureError) error.stderr = stderr
        fail(error)
      }
      else done()
    })
  })
}
