// Finite owned process group only; no installation, authorization or commit semantics.
import { spawn } from 'node:child_process'
import { once } from 'node:events'

export function ubuntuDesktopEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'TZ']
    .flatMap(name => source[name] ? [[name, source[name]!]] : [])), PATH: '/usr/bin:/bin' }
}

export async function runUbuntuProcess(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number, signal: AbortSignal, cwd?: string): Promise<{ code: number | null; diagnostic: string }> {
  signal.throwIfAborted()
  // A private process group contains only this finite operation and its children.
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let diagnostic = ''
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString('utf8')).slice(-8192) })
  let alive = true
  child.once('exit', () => { alive = false })
  const stop = () => {
    if (alive && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    // Closing our read endpoint also bounds draining after the parent exits.
    // It grants no authority to signal a now-unidentified descendant.
    child.stderr.destroy()
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; stop() }, timeout), cancelled = () => stop()
  signal.addEventListener('abort', cancelled, { once: true })
  try {
    await once(child, 'spawn')
    const [code] = await once(child, 'close')
    signal.throwIfAborted()
    return { code: timedOut ? null : code, diagnostic }
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancelled); stop() }
}
