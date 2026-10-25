import { verifyDataCompatibility } from './data-compatibility.mjs'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { runMigrations, previewMigrations } from '../upgrade-lib/migrate.mjs'
import { runScript } from '../upgrade-lib/runner.mjs'
import product from './product-runtime.cjs'
import workspace from './workspace-maintenance.cjs'
import management from './desktop-management.cjs'
import cliLocation from './cli-location.cjs'
import { assertLocalMigrationData } from './maintenance-backup.mjs'
import { readVersionMaintenance, assertVersionMaintenanceAllowsStart } from './version-maintenance.mjs'

export { verifyDataCompatibility } from './data-compatibility.mjs'

// Common preparation only: no password prompt, TTY, GUI, lifecycle lock or model calls.
export function prepareCoreEnvironment({ root, dataDir, source = process.env, loadInstallationEnv }) {
  assertVersionMaintenanceAllowsStart(dataDir)
  const installation = cliLocation.assertSelectedCli(root)
  const env = { ...source, DATA_DIR: resolve(dataDir) }
  const file = join(installation?.root ?? root, '.env')
  const readInstallationEnv = loadInstallationEnv ?? (installation?.scope !== 'system')
  if (readInstallationEnv && existsSync(file)) {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.replace(/#.*$/, '').trim(), split = line.indexOf('=')
      if (split > 0 && !env[line.slice(0, split)]) env[line.slice(0, split)] = line.slice(split + 1)
    }
  }
  env.CRABOT_JWT_SECRET ||= randomBytes(32).toString('hex')
  const runtime = product.loadProductRuntime(root, { required: env.CRABOT_PRODUCT_REQUIRED === '1' })
  const prepared = runtime ? product.productEnvironment(runtime, dataDir, env) : env
  if (!runtime) {
    const local = join(homedir(), '.local/bin')
    const paths = (prepared.PATH ?? '').split(delimiter)
    if (existsSync(local) && !paths.includes(local)) prepared.PATH = [local, ...paths].join(delimiter)
  }
  const bypass = new Set((prepared.NO_PROXY || prepared.no_proxy || '').split(',').map(value => value.trim()).filter(Boolean))
  for (const host of ['localhost', '127.0.0.1', '::1']) bypass.add(host)
  prepared.NO_PROXY = prepared.no_proxy = [...bypass].join(',')
  const managed = management.readDesktopManagement(dataDir)
  if (managed) prepared.CRABOT_ADMIN_WEB_HOST = managed.admin_listen_host
  for (const module of ['admin', 'agent', 'memory']) mkdirSync(join(dataDir, module), { recursive: true })
  return { env: prepared, runtime, managed }
}

// Caller owns the lifecycle lock and stopped-state proof. All adapters use the
// same scoped migrations and request preparation, before any business ingress.
export async function applyStartupMigrations(root, dataDir, env, log = () => {}, { outputFd } = {}) {
  assertVersionMaintenanceAllowsStart(dataDir)
  const pending = verifyDataCompatibility(root, dataDir)
  if (workspace.workspaceMaintenancePending(dataDir)) {
    const preview = await previewMigrations(root, dataDir)
    if (preview.modules.length || !['ready', 'not_applicable'].includes(preview.shared.status)) throw workspace.failure()
    return // Management recovery only: preserve the active intent and all business formats.
  }
  if (readVersionMaintenance(dataDir)?.backup) await assertLocalMigrationData(dataDir, pending, root)
  const result = await runMigrations(root, dataDir, (script, directory, context) => runScript(script, directory, { ...context, root, env, outputFd }),
    { info: log, warn: log, error: log }, { lockHeld: true })
  if (!result.ok) throw Object.assign(new Error(`Migration failed: ${result.failedModule}/${result.failedAt}`), { code: 'CRABOT_MIGRATION_FAILED' })
}
