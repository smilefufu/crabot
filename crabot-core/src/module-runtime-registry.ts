import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  isProcessTreeAlive as isOwnedProcessTreeAlive,
  terminateProcessTree as terminateOwnedProcessTree,
  waitForProcessTreeExit,
  type TerminateProcessTreeOptions,
} from './process-tree.js'

const SCHEMA_VERSION = 1

export interface ModuleRuntimeRecord {
  schema_version: typeof SCHEMA_VERSION
  instance_id: string
  runtime_id: string
  module_id: string
  root_pid: number
  process_start_identity: string
  module_port: number
  created_at: string
}

export interface RuntimeIdentity {
  instance_id: string
  module_id: string
  runtime_id: string
}

export interface WindowsPortOwner {
  pid: number
  process_name: string
  command_line?: string
  process_start_identity: string
}

export interface OrphanTerminationCandidate {
  record: ModuleRuntimeRecord
  record_path: string
  listener: WindowsPortOwner
}

interface RecordSpawnInput {
  runtimeId: string
  moduleId: string
  rootPid: number
  modulePort: number
}

interface RecoverOrphansInput {
  moduleId?: string
  currentRuntimeIds: ReadonlySet<string>
  gracefulTimeoutMs: number
}

export interface ModuleRuntimeRegistryOptions {
  probeProcessStartIdentity?: (pid: number) => Promise<string | null>
  isProcessTreeAlive?: (pid: number, modulePort: number, rootExited: boolean) => boolean | Promise<boolean>
  terminateProcessTree?: (pid: number, options: TerminateProcessTreeOptions) => Promise<void>
  inspectWindowsPortOwners?: (port: number) => Promise<WindowsPortOwner[]>
  probeRuntimeIdentity?: (port: number) => Promise<RuntimeIdentity | null>
  confirmOrphanTermination?: (candidate: OrphanTerminationCandidate) => Promise<boolean>
  platform?: NodeJS.Platform
  createId?: () => string
  now?: () => string
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function probeLinuxStartIdentity(pid: number): Promise<string | null> {
  try {
    const [stat, bootId] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ])
    const commandEnd = stat.lastIndexOf(')')
    const fieldsAfterCommand = commandEnd === -1
      ? []
      : stat.slice(commandEnd + 2).trim().split(/\s+/)
    const startTicks = fieldsAfterCommand[19]
    if (!startTicks) throw new Error(`Cannot parse process start identity for PID ${pid}`)
    return `linux:${bootId.trim()}:${startTicks}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function probePosixStartIdentity(pid: number): Promise<string | null> {
  try {
    const output = await execFileText('ps', ['-p', String(pid), '-o', 'lstart='])
    const startedAt = output.trim()
    return startedAt ? `${process.platform}:${startedAt}` : null
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return null
    throw error
  }
}

async function probeWindowsStartIdentity(pid: number): Promise<string | null> {
  const script = "$ErrorActionPreference='Stop'; "
    + `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; `
    + `if ($null -ne $process) { $process.CreationDate.ToUniversalTime().ToString('o') }`
  const output = await execFileText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  const startedAt = output.trim()
  return startedAt ? `win32:${startedAt}` : null
}

export async function probeProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'linux') return probeLinuxStartIdentity(pid)
  if (process.platform === 'win32') return probeWindowsStartIdentity(pid)
  return probePosixStartIdentity(pid)
}

export async function inspectWindowsPortOwners(port: number): Promise<WindowsPortOwner[]> {
  const script = "$ErrorActionPreference='Stop'; "
    + `$listenerPids = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue `
    + `| ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique); `
    + `$owners = @($listenerPids | ForEach-Object { `
    + `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = $($_)\"; `
    + `if ($null -ne $p) { [pscustomobject]@{ `
    + `pid = [int]$p.ProcessId; process_name = [string]$p.Name; `
    + `command_line = [string]$p.CommandLine; `
    + `process_start_identity = 'win32:' + $p.CreationDate.ToUniversalTime().ToString('o') } } }); `
    + `ConvertTo-Json -InputObject @($owners) -Compress -Depth 3`
  const output = await execFileText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  const decoded = JSON.parse(output.trim() || '[]') as unknown
  if (!Array.isArray(decoded)) throw new Error(`Invalid Windows port owner response for port ${port}`)
  return decoded.map((item) => {
    if (!item || typeof item !== 'object') throw new Error(`Invalid Windows port owner for port ${port}`)
    const owner = item as Partial<WindowsPortOwner>
    if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) <= 0
      || typeof owner.process_name !== 'string'
      || typeof owner.process_start_identity !== 'string') {
      throw new Error(`Invalid Windows port owner for port ${port}`)
    }
    return {
      pid: owner.pid!,
      process_name: owner.process_name,
      ...(owner.command_line ? { command_line: owner.command_line } : {}),
      process_start_identity: owner.process_start_identity,
    }
  })
}

export async function probeRuntimeIdentity(port: number): Promise<RuntimeIdentity | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/get_runtime_identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        source: 'module-manager',
        method: 'get_runtime_identity',
        params: {},
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return null
    const body = await response.json() as { success?: unknown; data?: unknown }
    if (body.success !== true || !body.data || typeof body.data !== 'object') return null
    const identity = body.data as Partial<RuntimeIdentity>
    if (typeof identity.instance_id !== 'string'
      || typeof identity.module_id !== 'string'
      || typeof identity.runtime_id !== 'string') return null
    return {
      instance_id: identity.instance_id,
      module_id: identity.module_id,
      runtime_id: identity.runtime_id,
    }
  } catch {
    return null
  }
}

export function formatOrphanTerminationCandidate(candidate: OrphanTerminationCandidate): string {
  const { record, listener } = candidate
  return [
    'A confirmed orphan Crabot module is still listening:',
    `  module_id: ${record.module_id}`,
    `  runtime_id: ${record.runtime_id}`,
    `  port: ${record.module_port}`,
    `  listener_pid: ${listener.pid}`,
    `  process_name: ${listener.process_name}`,
    `  command_line: ${JSON.stringify(listener.command_line ?? '')}`,
    `  process_start_identity: ${listener.process_start_identity}`,
    `  runtime_record: ${candidate.record_path}`,
  ].join('\n')
}

function isRuntimeRecord(value: unknown): value is ModuleRuntimeRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ModuleRuntimeRecord>
  return record.schema_version === SCHEMA_VERSION
    && typeof record.instance_id === 'string'
    && typeof record.runtime_id === 'string'
    && typeof record.module_id === 'string'
    && Number.isInteger(record.root_pid) && (record.root_pid ?? 0) > 0
    && typeof record.process_start_identity === 'string'
    && Number.isInteger(record.module_port) && (record.module_port ?? 0) > 0
    && typeof record.created_at === 'string'
}

export class ModuleRuntimeRegistry {
  private readonly registryDir: string
  private readonly recordsDir: string
  private readonly instanceIdPath: string
  private readonly probeStartIdentity: (pid: number) => Promise<string | null>
  private readonly isTreeAlive: (pid: number, modulePort: number, rootExited: boolean) => boolean | Promise<boolean>
  private readonly terminateTree: (pid: number, options: TerminateProcessTreeOptions) => Promise<void>
  private readonly inspectPortOwners: (port: number) => Promise<WindowsPortOwner[]>
  private readonly probeModuleIdentity: (port: number) => Promise<RuntimeIdentity | null>
  private readonly confirmTermination?: (candidate: OrphanTerminationCandidate) => Promise<boolean>
  private readonly platform: NodeJS.Platform
  private readonly createId: () => string
  private readonly now: () => string
  private initializePromise?: Promise<void>
  private instanceId?: string

  constructor(dataDir: string, options: ModuleRuntimeRegistryOptions = {}) {
    this.registryDir = path.join(dataDir, 'module-runtime-registry')
    this.recordsDir = path.join(this.registryDir, 'records')
    this.instanceIdPath = path.join(this.registryDir, 'instance-id')
    this.probeStartIdentity = options.probeProcessStartIdentity ?? probeProcessStartIdentity
    this.platform = options.platform ?? process.platform
    this.isTreeAlive = options.isProcessTreeAlive ?? (async (pid, modulePort, rootExited) => {
      if (this.platform !== 'win32') return isOwnedProcessTreeAlive(pid)
      return !await waitForProcessTreeExit(pid, 0, 100, modulePort, () => rootExited)
    })
    this.terminateTree = options.terminateProcessTree ?? terminateOwnedProcessTree
    this.inspectPortOwners = options.inspectWindowsPortOwners ?? inspectWindowsPortOwners
    this.probeModuleIdentity = options.probeRuntimeIdentity ?? probeRuntimeIdentity
    this.confirmTermination = options.confirmOrphanTermination
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async initialize(): Promise<void> {
    this.initializePromise ??= this.initializeOnce()
    await this.initializePromise
  }

  getInstanceId(): string {
    if (!this.instanceId) throw new Error('Module runtime registry is not initialized')
    return this.instanceId
  }

  createRuntimeId(): string {
    return this.createId()
  }

  async recordSpawn(input: RecordSpawnInput): Promise<ModuleRuntimeRecord> {
    await this.initialize()
    const processStartIdentity = await this.probeStartIdentity(input.rootPid)
    if (!processStartIdentity) {
      throw new Error(`Cannot capture process start identity for module ${input.moduleId} PID ${input.rootPid}`)
    }
    const record: ModuleRuntimeRecord = {
      schema_version: SCHEMA_VERSION,
      instance_id: this.getInstanceId(),
      runtime_id: input.runtimeId,
      module_id: input.moduleId,
      root_pid: input.rootPid,
      process_start_identity: processStartIdentity,
      module_port: input.modulePort,
      created_at: this.now(),
    }
    await this.writeAtomic(this.recordPath(record.runtime_id), `${JSON.stringify(record, null, 2)}\n`)
    return record
  }

  async removeRuntime(runtimeId: string): Promise<void> {
    try {
      await fs.unlink(this.recordPath(runtimeId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async listRecords(): Promise<ModuleRuntimeRecord[]> {
    await this.initialize()
    const entries = (await fs.readdir(this.recordsDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name))
    const records: ModuleRuntimeRecord[] = []
    for (const entry of entries) {
      const filePath = path.join(this.recordsDir, entry.name)
      let parsed: unknown
      try {
        parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
      } catch (error) {
        throw new Error(`Cannot read module runtime record ${filePath}: ${String(error)}`)
      }
      if (!isRuntimeRecord(parsed) || `${parsed.runtime_id}.json` !== entry.name) {
        throw new Error(`Invalid module runtime record: ${filePath}`)
      }
      records.push(parsed)
    }
    return records
  }

  async recoverOrphans(input: RecoverOrphansInput): Promise<void> {
    const records = await this.listRecords()
    for (const record of records) {
      if (record.instance_id !== this.getInstanceId()) continue
      if (input.moduleId !== undefined && record.module_id !== input.moduleId) continue
      if (input.currentRuntimeIds.has(record.runtime_id)) continue

      const currentIdentity = await this.probeStartIdentity(record.root_pid)
      if (this.platform === 'win32'
        && currentIdentity !== record.process_start_identity) {
        await this.recoverDetachedWindowsRuntime(record, input.gracefulTimeoutMs)
        continue
      }
      if (!currentIdentity) {
        if (!await this.isTreeAlive(record.root_pid, record.module_port, true)) {
          await this.removeRuntime(record.runtime_id)
          continue
        }
        await this.terminateTree(record.root_pid, {
          gracefulTimeoutMs: input.gracefulTimeoutMs,
          modulePort: record.module_port,
          requireOwnedProcess: true,
          isRootPidExited: () => true,
        })
        await this.removeRuntime(record.runtime_id)
        continue
      }
      if (currentIdentity !== record.process_start_identity) {
        // Detached POSIX modules use root_pid as PGID; that numeric PID cannot be
        // reused while any member of the recorded process group still exists.
        await this.removeRuntime(record.runtime_id)
        continue
      }

      await this.terminateTree(record.root_pid, this.platform === 'win32'
        ? {
            gracefulTimeoutMs: input.gracefulTimeoutMs,
            requireOwnedProcess: true,
          }
        : {
            gracefulTimeoutMs: input.gracefulTimeoutMs,
            modulePort: record.module_port,
            requireOwnedProcess: true,
          })
      if (this.platform === 'win32'
        && this.runtimeIdentityMatches(record, await this.probeModuleIdentity(record.module_port))) {
        throw new Error(
          `Cannot recover orphan ${record.module_id}/${record.runtime_id}: recorded runtime still responds after terminating root PID ${record.root_pid}; runtime record: ${this.recordPath(record.runtime_id)}`,
        )
      }
      await this.removeRuntime(record.runtime_id)
    }
  }

  private async recoverDetachedWindowsRuntime(
    record: ModuleRuntimeRecord,
    gracefulTimeoutMs: number,
  ): Promise<void> {
    const owners = await this.inspectPortOwners(record.module_port)
    if (owners.length === 0) {
      await this.removeRuntime(record.runtime_id)
      return
    }
    if (owners.length !== 1) {
      throw new Error(
        `Cannot recover orphan ${record.module_id}/${record.runtime_id}: port ${record.module_port} has ambiguous Windows listeners ${owners.map(owner => owner.pid).join(', ')}; runtime record: ${this.recordPath(record.runtime_id)}`,
      )
    }

    const listener = owners[0]
    const listenerIdentity = await this.probeStartIdentity(listener.pid)
    const runtimeIdentity = await this.probeModuleIdentity(record.module_port)
    if (listenerIdentity !== listener.process_start_identity
      || !this.runtimeIdentityMatches(record, runtimeIdentity)) {
      throw new Error(
        `Cannot recover orphan ${record.module_id}/${record.runtime_id}: listener on port ${record.module_port} did not prove the recorded runtime identity; listener PID ${listener.pid}; runtime record: ${this.recordPath(record.runtime_id)}`,
      )
    }

    const candidate: OrphanTerminationCandidate = {
      record,
      record_path: this.recordPath(record.runtime_id),
      listener,
    }
    if (!this.confirmTermination) {
      throw new Error(
        `${formatOrphanTerminationCandidate(candidate)}\nRun \`crabot start\` in an interactive terminal to approve termination, or stop this process manually.`,
      )
    }
    if (!await this.confirmTermination(candidate)) {
      throw new Error(`${formatOrphanTerminationCandidate(candidate)}\nStartup stopped because orphan termination was not approved.`)
    }

    const ownersAfterConfirmation = await this.inspectPortOwners(record.module_port)
    const runtimeIdentityAfterConfirmation = await this.probeModuleIdentity(record.module_port)
    const processIdentityAfterConfirmation = await this.probeStartIdentity(listener.pid)
    if (ownersAfterConfirmation.length !== 1
      || ownersAfterConfirmation[0].pid !== listener.pid
      || ownersAfterConfirmation[0].process_start_identity !== listener.process_start_identity
      || processIdentityAfterConfirmation !== listener.process_start_identity
      || !this.runtimeIdentityMatches(record, runtimeIdentityAfterConfirmation)) {
      throw new Error(
        `Cannot recover orphan ${record.module_id}/${record.runtime_id}: Windows listener identity changed during confirmation; runtime record: ${this.recordPath(record.runtime_id)}`,
      )
    }

    await this.terminateTree(listener.pid, {
      gracefulTimeoutMs,
      requireOwnedProcess: true,
    })
    await this.removeRuntime(record.runtime_id)
  }

  private runtimeIdentityMatches(
    record: ModuleRuntimeRecord,
    identity: RuntimeIdentity | null,
  ): boolean {
    return identity?.instance_id === record.instance_id
      && identity.module_id === record.module_id
      && identity.runtime_id === record.runtime_id
  }

  private async initializeOnce(): Promise<void> {
    await fs.mkdir(this.recordsDir, { recursive: true })
    try {
      const instanceId = (await fs.readFile(this.instanceIdPath, 'utf8')).trim()
      if (!instanceId) throw new Error(`Empty instance ID: ${this.instanceIdPath}`)
      this.instanceId = instanceId
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const instanceId = this.createId()
    await this.writeAtomic(this.instanceIdPath, `${instanceId}\n`)
    this.instanceId = instanceId
  }

  private recordPath(runtimeId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(runtimeId)) {
      throw new Error(`Invalid module runtime ID: ${runtimeId}`)
    }
    return path.join(this.recordsDir, `${runtimeId}.json`)
  }

  private async writeAtomic(target: string, content: string): Promise<void> {
    const temporary = `${target}.${process.pid}.${this.createId()}.tmp`
    try {
      await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
