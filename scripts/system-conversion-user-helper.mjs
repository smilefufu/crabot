// Dedicated legacy conversion role; no ordinary discovery/control permit can
// enter it. No employee I/O is performed until the actual UID/groups are dropped.
import fs from 'node:fs'
import { userInfo } from 'node:os'
import { readLegacySystemConversionPermit } from './lib/system-user.mjs'
import { conversionStopMaintenanceMatches } from './lib/system-conversion-permit.mjs'
import { readSystemBootId } from './lib/system-context.mjs'
import { coordinatorIsRunning } from './lib/system-coordinator.mjs'
const reply = frame => fs.writeFileSync(4, JSON.stringify(frame) + '\n')
const fail = () => { throw Object.assign(new Error('旧共享转换委托与当前根作业阶段不符，未停止实例。'), { code: 'CRABOT_SYSTEM_CONVERSION_PERMIT' }) }
try {
  if (process.platform !== 'linux' || process.argv.length !== 3 || process.argv[2] !== 'stop-legacy') fail()
  const permit = readLegacySystemConversionPermit(), entry = permit.entry, actual = userInfo()
  if (actual.uid !== entry.uid || actual.gid !== entry.gid || actual.username !== entry.user || actual.homedir !== entry.home) fail()
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
  if (!conversionStopMaintenanceMatches(permit, maintenance, readSystemBootId()) || !await coordinatorIsRunning(maintenance)) fail()
  const { stopFencedLegacySystemInstance } = await import('./lib/legacy-system-stop.mjs')
  const { user, uid, gid, home } = entry
  const result = await stopFencedLegacySystemInstance({ account: { user, uid, gid, home }, release: permit.source,
    port_offset_hint: entry.port_offset }, { expected: permit.observation })
  reply({ ok: true, result })
} catch (error) {
  const controlled = new Set(['CRABOT_SYSTEM_CONVERSION_PERMIT', 'CRABOT_LEGACY_SYSTEM_ACCOUNT', 'CRABOT_LEGACY_SYSTEM_RUNTIME',
    'CRABOT_LEGACY_RUNTIME_UNVERIFIED', 'CRABOT_LEGACY_UNSUPPORTED', 'CRABOT_LEGACY_STOP_UNKNOWN']).has(error.code)
  reply({ ok: false, code: controlled ? error.code : 'CRABOT_SYSTEM_CONVERSION_PERMIT',
    message: controlled ? error.message : '旧实例停止结果尚未核验，原安装和保护已保留，请核对本人状态。' })
  process.exitCode = 1
}
