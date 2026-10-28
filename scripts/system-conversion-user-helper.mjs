// Dedicated legacy conversion role; no ordinary discovery/control permit can
// enter it. No employee I/O is performed until the actual UID/groups are dropped.
import fs from 'node:fs'
import path from 'node:path'
import { userInfo } from 'node:os'
import { readLegacySystemConversionPermit, systemUserEnvironment } from './lib/system-user.mjs'
import { conversionMaintenanceMatches } from './lib/system-conversion-permit.mjs'
import { readSystemBootId } from './lib/system-context.mjs'
import { coordinatorIsRunning } from './lib/system-coordinator.mjs'
const reply = frame => fs.writeFileSync(4, JSON.stringify(frame) + '\n')
const fail = () => { throw Object.assign(new Error('旧共享转换委托与当前根作业阶段不符，未派发本次动作。'), { code: 'CRABOT_SYSTEM_CONVERSION_PERMIT' }) }
try {
  if (process.platform !== 'linux' || process.argv.length !== 3) fail()
  const permit = readLegacySystemConversionPermit(), entry = permit.entry, actual = userInfo()
  if (process.argv[2] !== permit.action || actual.uid !== entry.uid || actual.gid !== entry.gid || actual.username !== entry.user || actual.homedir !== entry.home) fail()
  process.stdin.setEncoding('utf8')
  let text = '', bytes = 0
  for await (const chunk of process.stdin) { bytes += Buffer.byteLength(chunk); if (bytes > 1024) fail(); text += chunk }
  const request = JSON.parse(text)
  if (request.input !== null || Object.keys(request).length !== 1) fail()
  let fd, maintenance
  try {
    fd = fs.openSync('/etc/crabot/system/maintenance.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022 || stat.nlink !== 1 || stat.size > 65536) fail()
    maintenance = JSON.parse(fs.readFileSync(fd, 'utf8'))
  } finally { if (fd !== undefined) fs.closeSync(fd) }
  if (!conversionMaintenanceMatches(permit, maintenance, readSystemBootId()) || !await coordinatorIsRunning(maintenance)) fail()
  let result
  if (permit.action === 'stop-legacy') {
    const { stopFencedLegacySystemInstance } = await import('./lib/legacy-system-stop.mjs')
    const { user, uid, gid, home } = entry
    result = await stopFencedLegacySystemInstance({ account: { user, uid, gid, home }, release: permit.source,
      port_offset_hint: entry.port_offset }, { expected: permit.observation })
  } else if (permit.action === 'start-legacy') {
    const { startRestoredLegacySystemInstance } = await import('./lib/legacy-system-start.mjs')
    const { user, uid, gid, home } = entry
    result = await startRestoredLegacySystemInstance(entry, { account: { user, uid, gid, home }, release: permit.source,
      port_offset_hint: entry.port_offset }, { expected: permit.observation, operationId: permit.operation_id })
  } else {
    const { maintainLegacySystemUser } = await import('./lib/system-legacy-data.mjs')
    result = await maintainLegacySystemUser(entry, { action: permit.action, source: permit.source, observation: permit.observation,
      sourceFenceId: permit.source_fence_id, operationId: permit.operation_id,
      targetRoot: path.join(permit.install_root, 'releases', permit.target.id), snapshot: permit.snapshot,
      env: systemUserEnvironment(entry) })
  }
  reply({ ok: true, result })
} catch (error) {
  const controlled = new Set(['CRABOT_SYSTEM_CONVERSION_PERMIT', 'CRABOT_LEGACY_SYSTEM_ACCOUNT', 'CRABOT_LEGACY_SYSTEM_RUNTIME',
    'CRABOT_LEGACY_SYSTEM_START_UNKNOWN', 'CRABOT_LEGACY_RUNTIME_UNVERIFIED', 'CRABOT_LEGACY_UNSUPPORTED', 'CRABOT_LEGACY_STOP_UNKNOWN', 'CRABOT_SYSTEM_CONVERSION_DATA', 'CRABOT_LEGACY_SYSTEM_DIRECTORY', 'CRABOT_DATA_MISSING']).has(error.code)
  reply({ ok: false, code: controlled ? error.code : 'CRABOT_SYSTEM_CONVERSION_PERMIT',
    message: controlled ? error.message : '旧实例转换结果尚未核验，原数据和保护已保留；请检查员工本人诊断与保留备份。' })
  process.exitCode = 1
}
