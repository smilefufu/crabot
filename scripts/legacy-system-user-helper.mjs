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
  const { discoverLegacySystemAccount } = await import('./lib/legacy-system-account.mjs')
  reply({ ok: true, result: await discoverLegacySystemAccount(permit) })
} catch {
  // No raw employee JSON, paths, provider credentials or stack enter root logs.
  reply({ ok: false, code: 'CRABOT_LEGACY_SYSTEM_ACCOUNT', message: '旧账号或部署来源无法核验，未转换；请核对该用户的原部署。' })
  process.exitCode = 1
}
