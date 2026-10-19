import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runMigrations } from './upgrade-lib/migrate.mjs'
import { runScript } from './upgrade-lib/runner.mjs'
import { inheritedCliLock } from './lib/cli-lock.mjs'
const dataRoot = process.argv.find(value => value.startsWith('--data-dir='))?.slice('--data-dir='.length)
if (!dataRoot) throw new Error('Missing --data-dir')
const root = path.resolve(dataRoot)
const result = await runMigrations(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), root, runScript, console, { lockHeld: inheritedCliLock(root) })
if (!result.ok) throw new Error(`Migration failed: ${result.failedModule}/${result.failedAt}; scoped backup: ${result.backupPath}`)
