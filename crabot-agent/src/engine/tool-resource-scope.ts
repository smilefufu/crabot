import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { readControl, readEvents, TOOL_CGROUP_ENV, verifyToolCgroup } from './tool-resources'

export interface ToolResourceScope {
  version: 1
  id: string
  root: string
  root_inode: number
  inode: number
  device: number
  memory_bytes: number
  tasks: number
  cpu_quota: number | null
}
export interface ToolResourceResult {
  status: 'ok' | 'limit' | 'unknown' | 'not_started'
  exit_code: number | null
  signal: string | null
  memory_events: Record<string, number>
  pids_events: Record<string, number>
  memory_peak_bytes: number | null
  cleanup: 'complete' | 'unknown'
  message?: string
}
interface Binding {
  scope: ToolResourceScope
  child: ChildProcess
  ready: Promise<boolean>
  result?: Promise<ToolResourceResult>
}
const children = new WeakMap<ChildProcess, Binding>()
const byPid = new Map<number, Binding>()

/** Prepared synchronously before spawn; an ordinary directory is never accepted as a cgroup. */
export function prepareToolScope(): ToolResourceScope | undefined {
  const configured = process.env[TOOL_CGROUP_ENV]
  if (!configured) return undefined
  const budget = verifyToolCgroup(configured)
  const id = randomUUID(), dir = path.join(budget.root, id)
  let created = false
  try {
    fs.mkdirSync(dir)
    created = true
    fs.writeFileSync(path.join(dir, 'memory.oom.group'), '1')
    // Also set local pids.max so task exhaustion is attributable to this invocation.
    fs.writeFileSync(path.join(dir, 'pids.max'), String(budget.pids))
    if (readControl(dir, 'memory.oom.group') !== '1' || readControl(dir, 'pids.max') !== String(budget.pids)) throw new Error('scope limits were not applied')
    fs.accessSync(path.join(dir, 'cgroup.kill'), fs.constants.W_OK)
    const stat = fs.statSync(dir), root = fs.statSync(budget.root)
    return { version: 1, id, root: budget.root, root_inode: root.ino, inode: stat.ino, device: stat.dev,
      memory_bytes: budget.memory, tasks: budget.pids, cpu_quota: budget.cpu }
  } catch (error) {
    if (created) {
      try { fs.rmdirSync(dir) } catch { console.error('[tool-resource] empty scope cleanup not confirmed:', dir) }
    }
    throw new Error(`RESOURCE_PROTECTION_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** No interpolated command text: positional parameters preserve argv/cwd/env exactly. */
export function scopedArgv(scope: ToolResourceScope, argv: readonly string[]): string[] {
  return ['/bin/sh', '-c',
    'if ! printf "%s\\n" "$$" > "$1/cgroup.procs"; then exit 125; fi; shift; printf ready >&3 || exit 125; exec 3>&-; exec "$@"',
    'crabot-tool-launch', path.join(scope.root, scope.id), ...argv]
}

export function bindToolScope(child: ChildProcess, scope: ToolResourceScope): void {
  const stream = child.stdio[3]
  const ready = new Promise<boolean>(resolve => {
    if (!stream || !('on' in stream)) { resolve(false); return }
    let marker = ''
    stream.on('data', chunk => { marker += String(chunk).slice(0, 16); if (marker === 'ready') resolve(true) })
    stream.on('error', () => resolve(false))
    stream.on('close', () => resolve(marker === 'ready'))
  })
  const binding: Binding = { scope, ready, child }
  children.set(child, binding)
  if (child.pid) byPid.set(child.pid, binding)
  // Cleanup starts on exit, not close: a double-forked descendant may still hold stdout open.
  child.once('exit', (code, signal) => { void finishToolResources(child, code, signal) })
  child.once('error', () => { void finishToolResources(child, null, null) })
}

export function toolScopeForChild(child: ChildProcess): ToolResourceScope | undefined { return children.get(child)?.scope }

function scopeDirectory(scope: ToolResourceScope): string {
  if (!scope || typeof scope !== 'object' || scope.version !== 1 || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(scope.id) || !path.isAbsolute(scope.root)) throw new Error('Invalid resource scope identity')
  const dir = path.join(scope.root, scope.id), root = fs.lstatSync(scope.root), stat = fs.lstatSync(dir)
  if (root.isSymbolicLink() || stat.isSymbolicLink() || root.ino !== scope.root_inode || stat.ino !== scope.inode || stat.dev !== scope.device
    || fs.statfsSync(dir).type !== 0x63677270) throw new Error('Resource scope identity changed')
  return dir
}
function killScope(scope: ToolResourceScope): void {
  fs.writeFileSync(path.join(scopeDirectory(scope), 'cgroup.kill'), '1')
}
/** A known scope never falls back to signalling a potentially reused PID. Async settlement verifies cleanup. */
export function terminateToolScope(pid: number): boolean {
  const binding = byPid.get(pid)
  if (!binding) return false
  try { killScope(binding.scope) } catch (error) { console.error('[tool-resource] group termination not confirmed:', error) }
  return true
}

function removeEmptyTree(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyTree(path.join(dir, entry.name))
  }
  fs.rmdirSync(dir)
}

/** Identity is checked before every destructive action, including after Agent restart. */
export async function finishResourceScope(scope: ToolResourceScope, exitCode: number | null, signal: NodeJS.Signals | null,
  started = true): Promise<ToolResourceResult> {
  const result: ToolResourceResult = { status: started ? 'ok' : 'not_started', exit_code: exitCode, signal,
    memory_events: {}, pids_events: {}, memory_peak_bytes: null, cleanup: 'unknown' }
  try {
    const dir = scopeDirectory(scope)
    killScope(scope)
    // This is a bounded cleanup wait, not a command or task deadline.
    const until = Date.now() + 2000
    while (readEvents(dir, 'cgroup.events').populated !== 0) {
      if (Date.now() >= until) throw new Error('Resource group remains populated')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    result.memory_events = readEvents(dir, 'memory.events')
    result.pids_events = readEvents(dir, 'pids.events')
    try { result.memory_peak_bytes = Number(readControl(dir, 'memory.peak')) } catch { /* Optional on older kernels. */ }
    if ((result.memory_events.oom_kill ?? 0) > 0 || (result.pids_events.max ?? 0) > 0) {
      result.status = 'limit'
      result.message = 'Tool resource budget exhausted; execution may have partial side effects. Command was not replayed.'
    }
    if (!started) result.message = 'RESOURCE_PROTECTION_UNAVAILABLE: launcher did not confirm cgroup entry; command was not started.'
    scopeDirectory(scope)
    removeEmptyTree(dir)
    result.cleanup = 'complete'
  } catch (error) {
    result.status = 'unknown'
    result.message = `Tool resource cleanup is unknown; execution may have partial side effects: ${error instanceof Error ? error.message : String(error)}`
  }
  return result
}

export async function finishToolResources(child: ChildProcess, code: number | null = child.exitCode,
  signal: NodeJS.Signals | null = child.signalCode): Promise<ToolResourceResult | undefined> {
  const binding = children.get(child)
  if (!binding) return undefined
  binding.result ??= binding.ready.then(started => finishResourceScope(binding.scope, code, signal, started))
  const result = await binding.result
  if (child.pid && byPid.get(child.pid) === binding) byPid.delete(child.pid)
  return result
}

export function resourceFailure(result: ToolResourceResult | undefined): string | undefined {
  return result && result.status !== 'ok' ? `${result.message ?? result.status} (exit=${result.exit_code}, signal=${result.signal}, cleanup=${result.cleanup})` : undefined
}

export async function stopResourceScope(scope: ToolResourceScope): Promise<ToolResourceResult> {
  if (!scope || typeof scope !== 'object') return finishResourceScope(scope, null, null)
  const binding = [...byPid.values()].find(item => item.scope.id === scope.id && item.scope.inode === scope.inode)
  if (!binding) return finishResourceScope(scope, null, null)
  try {
    killScope(scope)
    if (binding.child.exitCode === null && binding.child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { binding.child.off('exit', exited); reject(new Error('Tool exit not confirmed')) }, 2000)
        const exited = () => { clearTimeout(timer); resolve() }
        binding.child.once('exit', exited)
      })
    }
    return (await finishToolResources(binding.child))!
  } catch (error) {
    return { status: 'unknown', exit_code: binding.child.exitCode, signal: binding.child.signalCode, memory_events: {}, pids_events: {},
      memory_peak_bytes: null, cleanup: 'unknown', message: `Tool stop is unknown: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function terminateToolScopeAndWait(pid: number): Promise<boolean> {
  const binding = byPid.get(pid)
  if (!binding) return false
  const result = await stopResourceScope(binding.scope)
  if (result.cleanup !== 'complete') throw new Error(result.message ?? 'Tool resource cleanup unknown')
  return true
}
