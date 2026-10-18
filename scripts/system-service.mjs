// systemd runs this as the employee UID. Startup failures use exit 64 so a
// failed/unknown migration is not replayed by the service restart policy.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStream } from 'rotating-file-stream'
import { ownSystemEntry, applySystemUserBinding, assertSystemServiceStartAllowed } from './lib/system-context.mjs'
import { prepareCoreEnvironment } from './lib/core-preparation.mjs'
import { acquireStartupLock, releaseCliLock } from './lib/cli-lock.mjs'
import { runCorePreflight } from './lib/core-preflight.mjs'
import { inspectInstance } from './lib/instance-runtime.mjs'
import { runManagedCore } from './lib/managed-core.mjs'
import { verifyCoreRelease } from './lib/core-release.mjs'
import management from './lib/desktop-management.cjs'
import { prepareSystemStartupData } from './lib/system-startup-data.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
let lock
try {
  const entry = applySystemUserBinding(ownSystemEntry())
  assertSystemServiceStartAllowed(entry)
  await verifyCoreRelease(root)
  const dataDir = management.ensurePrivateDataRoot(entry.data_dir)
  lock = await acquireStartupLock(dataDir, 'system-service-start')
  assertSystemServiceStartAllowed(entry)
  if (inspectInstance(dataDir).state !== 'stopped') throw new Error('实例已经运行或身份未知，未创建第二个MM。')
  const prepared = prepareCoreEnvironment({ root, dataDir, loadInstallationEnv: false })
  const { readCredentials } = await import(new URL('../crabot-admin/dist/credentials.js', import.meta.url))
  if (!await readCredentials(path.join(dataDir, 'admin'))) throw new Error('浏览器初始凭据缺失，请管理员重新检查开通；未自动初始化。')
  const env = { ...prepared.env, CRABOT_TMP_PAGE_PORT: String(19099 + entry.port_offset), CRABOT_ORPHAN_RECOVERY_INTERACTIVE: '0' }
  const preflight = await runCorePreflight({ root, dataDir, node: process.execPath, stdio: 'inherit', env })
  if (preflight.exitCode !== 0) throw new Error('启动前恢复检查未完成，保留现场。')
  await prepareSystemStartupData({ root, dataDir, env })
  const logs = path.join(dataDir, 'logs'); fs.mkdirSync(logs, { recursive: true })
  const stdout = createStream('mm.stdout.log', { path: logs, size: '10M', maxFiles: 5 })
  const stderr = createStream('mm.stderr.log', { path: logs, size: '10M', maxFiles: 5 })
  const { mm } = await runManagedCore({ root, dataDir, mmPort: 19000 + entry.port_offset, env,
    stdio: ['ignore', 'pipe', 'pipe'], log: message => stdout.write(message),
    cleanup: code => { stdout.end(); stderr.end(); process.exit(code) } })
  mm.stdout.pipe(stdout); mm.stderr.pipe(stderr)
} catch (error) { console.error('[crabot] ' + error.message); process.exitCode = 64 }
finally { releaseCliLock(lock) }
