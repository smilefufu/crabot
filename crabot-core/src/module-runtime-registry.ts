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

interface ModuleRuntimeRegistryOptions {
  probeProcessStartIdentity?: (pid: number) => Promise<string | null>
  isProcessTreeAlive?: (pid: number, modulePort: number, rootExited: boolean) => boolean | Promise<boolean>
  terminateProcessTree?: (pid: number, options: TerminateProcessTreeOptions) => Promise<void>
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
  private readonly createId: () => string
  private readonly now: () => string
  private initializePromise?: Promise<void>
  private instanceId?: string

  constructor(dataDir: string, options: ModuleRuntimeRegistryOptions = {}) {
    this.registryDir = path.join(dataDir, 'module-runtime-registry')
    this.recordsDir = path.join(this.registryDir, 'records')
    this.instanceIdPath = path.join(this.registryDir, 'instance-id')
    this.probeStartIdentity = options.probeProcessStartIdentity ?? probeProcessStartIdentity
    this.isTreeAlive = options.isProcessTreeAlive ?? (async (pid, modulePort, rootExited) => {
      if (process.platform !== 'win32') return isOwnedProcessTreeAlive(pid)
      return !await waitForProcessTreeExit(pid, 0, 100, modulePort, () => rootExited)
    })
    this.terminateTree = options.terminateProcessTree ?? terminateOwnedProcessTree
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
      if (!currentIdentity) {
        if (!await this.isTreeAlive(record.root_pid, record.module_port, true)) {
          await this.removeRuntime(record.runtime_id)
          continue
        }
        if (process.platform === 'win32') {
          throw new Error(
            `Cannot recover orphan ${record.module_id}/${record.runtime_id}: root exited and remaining Windows process ownership is ambiguous`,
          )
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
        if (process.platform !== 'win32') {
          // Detached POSIX modules use root_pid as PGID; that numeric PID cannot be
          // reused while any member of the recorded process group still exists.
          await this.removeRuntime(record.runtime_id)
          continue
        }
        throw new Error(
          `Cannot recover orphan ${record.module_id}/${record.runtime_id}: process start identity changed for PID ${record.root_pid}`,
        )
      }

      await this.terminateTree(record.root_pid, {
        gracefulTimeoutMs: input.gracefulTimeoutMs,
        modulePort: record.module_port,
        requireOwnedProcess: true,
      })
      await this.removeRuntime(record.runtime_id)
    }
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
