import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { scanModules, applyMigration } from '../upgrade-lib/migrate.mjs'
import { runScript } from '../upgrade-lib/runner.mjs'
import product from './product-runtime.cjs'
import management from './desktop-management.cjs'
import cliLocation from './cli-location.cjs'
import { assertLocalMigrationData } from './maintenance-backup.mjs'
import { readVersionMaintenance, assertVersionMaintenanceAllowsStart } from './version-maintenance.mjs'

// Common preparation only: no password prompt, TTY, GUI, lifecycle lock or model calls.
export function prepareCoreEnvironment({ root, dataDir, source = process.env }) {
  assertVersionMaintenanceAllowsStart(dataDir)
  const installation = cliLocation.assertSelectedCli(root)
  const env = { ...source, DATA_DIR: resolve(dataDir) }
  const file = join(installation?.root ?? root, '.env')
  if (existsSync(file)) {
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

// Original start-time migration semantics: caller has proved stopped state and owns
// the lifecycle lock; upgrade/takeover adapters own their separate backup requirement.
export async function applyStartupMigrations(root, dataDir, env, log = () => {}) {
  assertVersionMaintenanceAllowsStart(dataDir)
  const pending = verifyDataCompatibility(root, dataDir)
  if (readVersionMaintenance(dataDir)?.backup) await assertLocalMigrationData(dataDir, pending)
  for (const migration of pending) {
    log(`${migration.moduleId}: ${migration.dataVersion ?? 'fresh'} → ${migration.codeVersion}`)
    const result = await applyMigration(join(root, migration.moduleId), migration.dataDir, migration.dataVersion,
      migration.codeVersion, (script, directory) => runScript(script, directory, { root, env }))
    if (!result.ok) throw Object.assign(new Error(`Migration failed: ${migration.moduleId}/${result.failedAt}`), { code: 'CRABOT_MIGRATION_FAILED' })
  }
}

export function verifyDataCompatibility(root, dataDir) {
  const pending = scanModules(root, dataDir)
  // Preflight the whole version set before the first module can mutate data.
  // A rollback cannot turn a newer schema into an older one by relabelling it.
  for (const migration of pending) {
    const versions = [migration.dataVersion ?? 'v0', migration.codeVersion]
    if (versions.some(value => !/^v\d+$/.test(value) || !Number.isSafeInteger(Number(value.slice(1))))) {
      throw Object.assign(new Error(`Invalid schema version: ${migration.moduleId}`), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
    }
    if (Number(versions[0].slice(1)) > Number(versions[1].slice(1))) {
      throw Object.assign(new Error(`Data requires a newer core: ${migration.moduleId}`), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
    }
  }
  return pending
}
