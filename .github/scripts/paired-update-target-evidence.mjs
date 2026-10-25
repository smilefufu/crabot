// CI-only observation before fixture cleanup. Never export paths, arguments,
// configuration, tokens or raw log text; this does not authorize recovery.
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { inspectInstance, identity } from '../../scripts/lib/instance-runtime.mjs'
import { verifyDataCompatibility } from '../../scripts/lib/data-compatibility.mjs'
import { readVersionMaintenance } from '../../scripts/lib/version-maintenance.mjs'
import entry from '../../scripts/lib/desktop-entry.cjs'

async function boundedFile(file, maximum, tail = false) {
  let handle
  try {
    const before = await fs.lstat(file)
    if (!before.isFile() || before.nlink !== 1 || !tail && before.size > maximum) return { status: 'unreadable' }
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const current = await handle.stat()
    if (!current.isFile() || current.nlink !== 1 || before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size) return { status: 'unreadable' }
    const bytes = Buffer.alloc(Math.min(current.size, maximum))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, tail ? Math.max(0, current.size - maximum) : 0)
    return { status: 'readable', text: bytes.subarray(0, bytesRead).toString('utf8'), modified: current.mtimeMs }
  } catch (error) { return { status: error.code === 'ENOENT' ? 'absent' : 'unreadable' } }
  finally { await handle?.close() }
}
export async function collectPairedUpdateTargetEvidence({ dataDir, targetRoot, targetIdentity, handoffAt = null }) {
  const evidence = { target_observed: !!targetIdentity, target_alive: false, ordinary_peer_verified: false }
  if (targetIdentity) {
    try {
      evidence.target_alive = identity.sameProcess(targetIdentity, identity.inspectProcess(targetIdentity.pid))
      evidence.ordinary_peer_verified = entry.verifyDesktopEntry(targetIdentity, entry.loadDesktopEntry(targetRoot))
    } catch { /* A dead or unverified target is evidence, not a cleanup authority. */ }
  }
  const runtimeFile = await boundedFile(path.join(dataDir, 'instance-runtime.json'), 65536)
  evidence.runtime = { status: runtimeFile.status }
  if (runtimeFile.status !== 'unreadable') {
    try {
      const runtime = inspectInstance(dataDir)
      Object.assign(evidence.runtime, { state: runtime.state, target_core_matches: runtime.record?.install_root === targetRoot,
        controller_alive: !!runtime.record && identity.sameProcess(runtime.record.controller, identity.inspectProcess(runtime.record.controller.pid)),
        mm_alive: !!runtime.record?.mm && identity.sameProcess(runtime.record.mm, identity.inspectProcess(runtime.record.mm.pid)) })
    } catch { evidence.runtime.status = 'unreadable' }
  }
  const maintenanceFile = await boundedFile(path.join(dataDir, 'desktop-maintenance.json'), 65536)
  evidence.maintenance = { status: maintenanceFile.status }
  if (maintenanceFile.status === 'readable') {
    try {
      const record = readVersionMaintenance(dataDir)
      if (record) Object.assign(evidence.maintenance, { schema_version: record.schema_version, phase: record.phase, target_core_matches: record.target_core?.root === targetRoot })
      else evidence.maintenance.status = 'absent'
    } catch { evidence.maintenance.status = 'unreadable' }
  }
  try {
    const pending = verifyDataCompatibility(targetRoot, dataDir)
    if (pending.length > 64 || pending.some(item => !/^crabot-[A-Za-z0-9_-]{1,64}$/.test(item.moduleId))) throw new Error('Invalid diagnostic module list')
    evidence.schema = { status: 'readable', pending: pending.map(item => ({ module_id: item.moduleId, code_version: item.codeVersion, data_version: item.dataVersion })) }
  } catch { evidence.schema = { status: 'unreadable' } }
  evidence.logs = {}
  const logDirectory = path.join(dataDir, 'logs')
  const logDirectorySafe = await fs.lstat(logDirectory).then(value => value.isDirectory(), () => false)
  for (const name of ['supervisor.boot.log', 'mm.stdout.log', 'mm.stderr.log', 'admin-web.log', 'agent.log', 'memory.log']) {
    const file = logDirectorySafe ? await boundedFile(path.join(logDirectory, name), 8192, true) : { status: 'unreadable' }
    const summary = { status: file.status }
    if (file.status === 'readable') Object.assign(summary, {
      modified_after_handoff: handoffAt === null ? null : file.modified >= handoffAt,
      codes: [...new Set(file.text.match(/\bCRABOT_[A-Z][A-Z0-9_]{0,79}\b/g) || [])].sort(),
      module_not_found: /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module/.test(file.text),
      address_in_use: /EADDRINUSE/.test(file.text), permission_denied: /EACCES|EPERM/.test(file.text),
    })
    evidence.logs[name] = summary
  }
  return evidence
}

// Fixed code/phase vocabulary only. Never export raw stdout, paths or user text.
export function summarizePairedTargetBootstrap(output, version) {
  if (typeof output !== 'string' || output.length > 65536) throw new Error('Invalid bounded bootstrap output')
  const codes = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM', 'ERR_INVALID_PACKAGE_CONFIG', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_DLOPEN_FAILED',
    'CRABOT_CORE_INTEGRITY', 'CRABOT_MAINTENANCE_PENDING', 'CRABOT_MIGRATION_INTERRUPTED', 'CRABOT_DATA_MISSING', 'CRABOT_DESKTOP_INSTALLATION',
    'CRABOT_DESKTOP_TAKEOVER_REQUIRED', 'DESKTOP_UNAVAILABLE', 'DESKTOP_BOOT_FAILED']
  const phases = ['binding-installation', 'loading-installation-verifier', 'installation-verifier-loaded', 'installation-pin-read',
    'installation-discovered', 'installation-validated', 'environment-bound', 'profile-configured', 'instance-lock-acquired', 'instance-lock-denied', 'installation-bound', 'data-location-checked', 'app-ready', 'reading-login-startup', 'login-startup-read',
    'loading-local-interface', 'local-interface-loaded', 'recovering-service', 'failed']
  const events = []
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event?.component === 'desktop-bootstrap' && phases.includes(event.phase)) events.push({ phase: event.phase,
        ...(event.phase === 'app-ready' ? { version_matches_current: event.app_version === version } : {}) })
    } catch {}
  }
  return { events: events.slice(-32), codes: codes.filter(code => output.includes(code)),
    missing_packages: ['crabot-client', 'zod', 'electron-updater', '@electron/asar'].filter(name => output.includes("Cannot find package '" + name + "'")) }
}
