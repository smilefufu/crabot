import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { acquireCliLock, releaseCliLock, cliLockToken } from '../lib/cli-lock.mjs'
import { inspectInstance } from '../lib/instance-runtime.mjs'
import { prepareCoreEnvironment, applyStartupMigrations } from '../lib/core-preparation.mjs'
import { launchBackgroundCore } from '../lib/background-core.mjs'
import management from '../lib/desktop-management.cjs'
import { detectMode } from '../lib/mode.mjs'
import { verifyCoreRelease } from '../lib/core-release.mjs'
import { assertVersionMaintenanceAllowsStart } from '../lib/version-maintenance.mjs'

// Desktop presentation adapter. Shared preparation/migration/controller layers have
// no TTY, password, task source, session, delivery or recovery-task semantics.
export async function startDesktopCore({ root, dataDir, source = process.env, onStage }) {
  const stage = value => { try { onStage?.(value) } catch {} }
  stage('verify_core')
  if (existsSync(join(root, 'core-release.json'))) await verifyCoreRelease(root)
  if (detectMode() === 'system' || source.CRABOT_DEV === 'true' || Number(source.CRABOT_PORT_OFFSET ?? 0) !== 0) {
    throw Object.assign(new Error('此部署需要使用原管理方式；桌面不会自动接管 system/dev 实例。'), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
  }
  management.ensurePrivateDataRoot(dataDir)
  const lock = cliLockToken(join(dataDir, 'cli.lock')) ? undefined : await acquireCliLock(dataDir, 'desktop-start')
  try {
    assertVersionMaintenanceAllowsStart(dataDir)
    const current = inspectInstance(dataDir)
    if (current.state !== 'stopped') throw Object.assign(new Error('请先核对已有实例。'), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
    management.initializeDesktopManagement(dataDir)
    stage('prepare_environment')
    const { env, runtime } = prepareCoreEnvironment({ root, dataDir, source: { ...source, CRABOT_PRODUCT_REQUIRED: '1', CRABOT_ORPHAN_RECOVERY_INTERACTIVE: '0' } })
    if (!runtime) throw new Error('内置运行环境缺失，请修复安装。')
    const mmPort = 19000, webPort = 3000
    env.CRABOT_TMP_PAGE_PORT = '19099'
    const entry = join(root, 'crabot-core/dist/orphan-recovery-preflight.js')
    if (!existsSync(entry) || !existsSync(join(root, 'crabot-core/dist/main.js'))) throw new Error('核心文件缺失，请修复安装。')
    await new Promise((resolve, reject) => {
      const probe = createServer()
      probe.once('error', () => reject(Object.assign(new Error('Crabot 本机端口已被占用，请查看诊断。'), { code: 'CRABOT_PORT_BUSY' })))
      probe.listen(mmPort, '127.0.0.1', () => probe.close(resolve))
    })
    stage('orphan_preflight')
    await promisify(execFile)(runtime.executables.node, [entry], { cwd: join(root, 'crabot-core'), env, timeout: 120_000, maxBuffer: 1024 * 1024 })
    stage('migrations')
    await applyStartupMigrations(root, dataDir, env)
    stage('launch_controller')
    return await launchBackgroundCore({ root, dataDir, env, mmPort, webPort })
  } finally { if (lock) releaseCliLock(lock) }
}
