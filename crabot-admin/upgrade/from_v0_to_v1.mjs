import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { previewLegacyDirectoryPermissions } from './legacy-directory-inputs.mjs'
import { hash, fileDigest, writeAtomic, scopedPath } from '../../scripts/upgrade-lib/scoped-data.mjs'
const argument = process.argv.find(value => value.startsWith('--data-dir='))
if (!argument) throw new Error('An Admin data directory is required')
const dataDir = await fs.realpath(argument.slice(11)), dataRoot = path.dirname(dataDir)
const result = await previewLegacyDirectoryPermissions(dataRoot)
if (!process.argv.includes('--dry-run')) {
  const filename = process.env.CRABOT_MIGRATION_PLAN
  if (!filename) throw new Error('Use the common scoped migration entry before writing Admin permissions')
  const bytes = await fs.readFile(filename), plan = JSON.parse(bytes), description = plan.description
  if (hash(bytes) !== process.env.CRABOT_MIGRATION_PLAN_SHA256 || description.module_id !== 'crabot-admin'
    || description.from !== null || description.to !== 'v1' || await fs.realpath(description.data_root) !== dataRoot || await fs.realpath(path.join(dataRoot, 'admin')) !== dataDir
    || description.id !== 'crabot-admin-v0-v1' || await fs.realpath(filename) !== path.join(dataRoot, '.upgrade-migrations', description.id, 'plan.json')) throw new Error('Admin migration context mismatch')
  const state = JSON.parse(await fs.readFile(path.join(path.dirname(filename), 'state.json'), 'utf8'))
  const script = fileURLToPath(import.meta.url), expected = description.scripts.length === 1 ? description.scripts[0] : undefined
  if (state.phase !== 'running' || state.plan_sha256 !== hash(bytes) || !expected || await fs.realpath(expected.path) !== script || await fileDigest(script) !== expected.sha256) throw new Error('Admin scoped backup is not active')
  for (const [name, records] of [['admin/friend-permission-configs.json', result.friendConfigs], ['admin/session-configs.json', result.groups]]) {
    if (!description.scope.writes.includes(name.split('/').join(path.sep))) throw new Error('Admin migration write outside declared scope')
    await writeAtomic(await scopedPath(dataRoot, name), JSON.stringify(records, null, 2) + '\n')
  }
}
console.log(JSON.stringify(result.report))
