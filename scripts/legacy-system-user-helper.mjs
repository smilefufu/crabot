// Fixed read-only discovery role, executed only after setpriv drops UID/groups.
import fs from 'node:fs'
import { readLegacySystemAccountPermit } from './lib/system-user.mjs'
const reply = frame => fs.writeFileSync(4, JSON.stringify(frame) + '\n')
try {
  if (process.platform !== 'linux' || process.argv.length !== 3 || process.argv[2] !== 'discover-legacy') throw new Error('Invalid discovery entry')
  const permit = readLegacySystemAccountPermit()
  let input = '', bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 1024) throw new Error('Invalid discovery input')
    input += chunk.toString('utf8')
  }
  const request = JSON.parse(input)
  if (request.input !== null || Object.keys(request).length !== 1) throw new Error('Invalid discovery input')
  const { discoverLegacySystemDeployment } = await import('./lib/legacy-system-runtime.mjs')
  reply({ ok: true, result: await discoverLegacySystemDeployment(permit) })
} catch (error) {
  // Only fixed discovery errors cross the boundary; no filesystem exception,
  // employee JSON, provider credential or stack enters root logs.
  const controlled = new Set(['CRABOT_LEGACY_SYSTEM_ACCOUNT', 'CRABOT_LEGACY_SYSTEM_RUNTIME', 'CRABOT_LEGACY_RUNTIME_UNVERIFIED', 'CRABOT_LEGACY_UNSUPPORTED', 'CRABOT_DATA_MISSING', 'CRABOT_LEGACY_SYSTEM_DIRECTORY']).has(error.code)
  reply({ ok: false, code: controlled ? error.code : 'CRABOT_LEGACY_SYSTEM_ACCOUNT',
    message: controlled ? error.message : '旧账号或部署来源无法核验，未转换；请核对该用户的原部署。' })
  process.exitCode = 1
}
