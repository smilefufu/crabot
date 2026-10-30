// Observe old module records with the same start-identity producer as Core.
// Records are not running processes. Only explicit, locked takeover removes
// records whose old root/tree and (on Windows) listener are already gone.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import start from './module-process-start.cjs'
import { cliLockToken } from './cli-lock.mjs'

const run = promisify(execFile)
const fail = () => { throw Object.assign(new Error('旧模块仍在运行或其退出状态无法核验，未继续接管。'), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' }) }

export async function readStoppedLegacyModuleRecords(dataDir) {
  const directory = path.join(dataDir, 'module-runtime-registry'), records = path.join(directory, 'records')
  const names = await fs.readdir(records).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const files = names.filter(name => name.endsWith('.json'))
  if (!files.length) return []
  try {
    const instanceId = (await fs.readFile(path.join(directory, 'instance-id'), 'utf8')).trim(), result = []
    if (!instanceId) fail()
    for (const name of files) {
      const file = path.join(records, name)
      if (!(await fs.lstat(file)).isFile()) fail()
      const bytes = await fs.readFile(file, 'utf8'), record = JSON.parse(bytes)
      if (record?.schema_version !== 1 || record.instance_id !== instanceId
        || typeof record.runtime_id !== 'string' || name !== record.runtime_id + '.json'
        || typeof record.module_id !== 'string' || !record.module_id || typeof record.created_at !== 'string'
        || !Number.isInteger(record.root_pid) || record.root_pid <= 0 || record.root_pid > 2147483647
        || typeof record.process_start_identity !== 'string' || !record.process_start_identity
        || !Number.isInteger(record.module_port) || record.module_port <= 0 || record.module_port > 65535) fail()
      const current = await start.probeProcessStartIdentity(record.root_pid)
      if (current === record.process_start_identity) fail()
      // Core's POSIX modules own a detached process group. A missing group root
      // alone does not establish that its children have exited. A reused root
      // PID means the old group no longer exists, as in Core orphan recovery.
      if (process.platform !== 'win32' && !current) {
        try { process.kill(-record.root_pid, 0); fail() }
        catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      result.push({ file, bytes, record })
    }
    if (process.platform === 'win32') {
      // .NET observes IPv4 and IPv6 listeners without a per-record shell or
      // administrator privileges. Query failure is not an empty listener list.
      const script = "$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port } | Sort-Object -Unique) -Compress"
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 })
      const ports = JSON.parse(stdout.trim())
      if (!Array.isArray(ports) || !ports.every(port => Number.isInteger(port) && port > 0 && port <= 65535)
        || result.some(({ record }) => ports.includes(record.module_port))) fail()
    }
    return result
  } catch { fail() }
}

export async function removeStoppedLegacyModuleRecords(dataDir) {
  const records = await readStoppedLegacyModuleRecords(dataDir)
  if (!records.length) return
  if (!cliLockToken(path.join(dataDir, 'cli.lock'))) fail()
  for (const { file, bytes } of records) {
    if (await fs.readFile(file, 'utf8') !== bytes) fail()
    await fs.unlink(file)
  }
}
