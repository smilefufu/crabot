import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExecutionResources } from 'crabot-shared'

export const TOOL_CGROUP_ENV = 'CRABOT_TOOL_CGROUP_ROOT'
const positive = (value: string | undefined): number | null => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}
export function readControl(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), 'utf8').trim()
}
export function readEvents(dir: string, name: string): Record<string, number> {
  return Object.fromEntries(readControl(dir, name).split('\n').map(line => {
    const [key, value] = line.split(/\s+/)
    if (!key || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error(`Invalid ${name}`)
    return [key, Number(value)]
  }))
}

/** Map membership through mountinfo: a container may expose only a subtree of the hierarchy. */
export function currentCgroup(procRoot = '/proc'): { mount: string; current: string } | null {
  try {
    const member = fs.readFileSync(path.join(procRoot, 'self/cgroup'), 'utf8').split('\n').find(line => line.startsWith('0::'))?.slice(3)
    if (!member || member.split('/').includes('..')) return null
    const mounts: Array<{ mount: string; current: string; rootLength: number }> = []
    for (const line of fs.readFileSync(path.join(procRoot, 'self/mountinfo'), 'utf8').split('\n')) {
      const [left, right] = line.split(' - ')
      if (!right?.startsWith('cgroup2 ')) continue
      const fields = left.split(' '), decode = (s: string) => s.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
      const root = decode(fields[3]), mount = decode(fields[4])
      if (member !== root && !member.startsWith(root.replace(/\/$/, '') + '/')) continue
      mounts.push({ mount, current: path.join(mount, path.relative(root, member)), rootLength: root.length })
    }
    const match = mounts.sort((a, b) => b.rootLength - a.rootLength)[0]
    if (match) return { mount: match.mount, current: match.current }
  } catch { /* Unknown is a fact, not permission to assume host capacity. */ }
  return null
}

export function cgroupLimits(current: string, mount: string): { cpu: number | null; memory: number | null } {
  let cpu: number | null = null, memory: number | null = null
  for (let dir = current; ; dir = path.dirname(dir)) {
    try {
      const [quota, period] = readControl(dir, 'cpu.max').split(/\s+/)
      const q = positive(quota), p = positive(period)
      if (q && p) cpu = Math.min(cpu ?? Infinity, q / p)
    } catch { /* Controller may not be exposed at this level. */ }
    try {
      const value = positive(readControl(dir, 'memory.max'))
      if (value) memory = Math.min(memory ?? Infinity, value)
    } catch { /* Keep only observed bounds. */ }
    if (dir === mount || dir === path.dirname(dir)) break
  }
  return { cpu, memory }
}

/** Only the deployment may provision the aggregate cap; runtime never raises it. */
export function verifyToolCgroup(root: string): { root: string; memory: number; pids: number; cpu: number | null } {
  const fail = (reason: string): never => { throw new Error(`RESOURCE_PROTECTION_UNAVAILABLE: ${reason}`) }
  if (process.platform !== 'linux') return fail('Linux cgroup v2 is required')
  try {
    root = fs.realpathSync(root)
    if (fs.statfsSync(root).type !== 0x63677270) return fail('not a cgroup v2 filesystem')
    const membership = currentCgroup()
    if (!membership) return fail('Agent membership is unknown')
    const agent = fs.realpathSync(membership.current)
    if (agent === root || agent.startsWith(root + path.sep)) return fail('Agent must be outside the tool branch')
    if (root !== membership.mount && !root.startsWith(membership.mount + path.sep)) return fail('tool branch is outside the visible cgroup mount')
    if (!agent.startsWith(path.dirname(root) + path.sep)) return fail('Agent and tools must share the reserved parent budget')
    const parentDir = path.dirname(root)
    const requireReadOnly = (file: string) => {
      let writable = true
      try { fs.accessSync(file, fs.constants.W_OK) } catch { writable = false }
      if (writable) return fail('tool identity must not control the controller branch or aggregate caps')
    }
    requireReadOnly(parentDir)
    for (let dir = agent; dir !== parentDir; dir = path.dirname(dir)) requireReadOnly(path.join(dir, 'cgroup.procs'))
    for (const file of ['memory.max', 'pids.max', 'memory.oom.group']) requireReadOnly(path.join(root, file))
    const memory = positive(readControl(root, 'memory.max')), pids = positive(readControl(root, 'pids.max'))
    const parent = cgroupLimits(path.dirname(root), membership.mount)
    if (!memory || !pids || !Number.isSafeInteger(memory) || !Number.isSafeInteger(pids)) return fail('finite memory.max and pids.max are required')
    if (!parent.memory || memory >= parent.memory) return fail('parent must reserve memory outside the tool budget')
    if (readControl(root, 'memory.oom.group') !== '1') return fail('aggregate group OOM is required')
    const controllers = readControl(root, 'cgroup.subtree_control').split(/\s+/)
    if (!['memory', 'pids'].every(c => controllers.includes(c))) return fail('memory/pids must be delegated')
    if (readControl(root, 'cgroup.type') !== 'domain') return fail('domain cgroup is required')
    fs.accessSync(root, fs.constants.W_OK | fs.constants.X_OK)
    const limits = cgroupLimits(root, membership.mount)
    return { root, memory: Math.min(memory, limits.memory ?? memory), pids, cpu: limits.cpu }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RESOURCE_PROTECTION_UNAVAILABLE:')) throw error
    return fail(error instanceof Error ? error.message : String(error))
  }
}

export function readExecutionResources(options: { platform?: string; procRoot?: string; visibleCpuCount?: number } = {}): ExecutionResources {
  const visible = options.visibleCpuCount ?? (os.availableParallelism?.() ?? os.cpus().length)
  const declared = { cpu: positive(process.env.CRABOT_EXECUTION_CPU_LIMIT), memory_bytes: positive(process.env.CRABOT_EXECUTION_MEMORY_BYTES) }
  const group = (options.platform ?? process.platform) === 'linux' ? currentCgroup(options.procRoot) : null
  const limits = group ? cgroupLimits(group.current, group.mount) : { cpu: null, memory: null }
  let protection: ExecutionResources['protection'] = 'unprotected'
  let memory = limits.memory, cpu = limits.cpu
  if (process.env[TOOL_CGROUP_ENV]) {
    try {
      const tools = verifyToolCgroup(process.env[TOOL_CGROUP_ENV]!)
      protection = 'cgroup_v2'; memory = Math.min(memory ?? Infinity, tools.memory)
      if (tools.cpu) cpu = Math.min(cpu ?? Infinity, tools.cpu)
    } catch { protection = 'unavailable' }
  }
  return {
    declared,
    observed: { visible_cpu_count: visible, cpu_quota: cpu, memory_bytes: memory },
    effective: { cpu_count: Math.max(1, Math.floor(Math.min(visible, cpu ?? Infinity, declared.cpu ?? Infinity))),
      memory_bytes: memory === null ? declared.memory_bytes : Math.min(memory, declared.memory_bytes ?? Infinity) },
    protection,
  }
}

/** One child only. Never mutate process.env or rewrite explicit command arguments. */
export function resourceChildEnv(env: Record<string, string>, resources = readExecutionResources()): Record<string, string> {
  const child = { ...env, PYTEST_XDIST_AUTO_NUM_WORKERS: String(resources.effective.cpu_count) }
  delete (child as Record<string, string>)[TOOL_CGROUP_ENV]
  return child
}
export function executionResourceContext(): string {
  return `本地工具资源（宿主实测；不适用于外部MCP/第三方CLI）：${JSON.stringify(readExecutionResources())}。自动并行按effective.cpu_count；多个工具共享内存预算。资源不足可能已有部分副作用，不能自动重放命令。`
}
