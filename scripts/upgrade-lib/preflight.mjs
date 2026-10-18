import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { verifyReleasePackage } from '../lib/release-package.mjs'
import { preparedMemoryPython } from '../lib/memory-deps.mjs'
import { previewMigrations } from './migrate.mjs'

/** Read-only restart check. Never downloads, builds, stops processes or writes data. */
export async function preflightRestart(home, dataRoot) {
  for (const name of ['crabot-core/dist/main.js', 'crabot-core/dist/orphan-recovery-preflight.js', 'crabot-admin/dist/main.js', 'crabot-agent/dist/main.js', 'scripts/prepare-shared-requests.mjs']) {
    if (!(await fs.stat(path.join(home, name))).isFile()) throw new Error(`Target build missing: ${name}; prepare it before restarting`)
  }
  if (await fs.stat(path.join(home, 'scripts/lib/package.json')).then(() => true, () => false)) {
    try { createRequire(path.join(home, 'scripts/lib/package.json')).resolve('proper-lockfile') }
    catch { throw new Error('Target CLI dependencies are missing; prepare upgrade before restarting') }
  }
  if (await fs.stat(path.join(home, 'crabot-memory/pyproject.toml')).then(() => true, () => false)) await preparedMemoryPython(path.join(home, 'crabot-memory'))
  if (await fs.stat(path.join(home, 'scripts/check-release.mjs')).then(() => true, () => false)) await verifyReleasePackage(home)
  const preview = await previewMigrations(home, dataRoot)
  if (preview.shared.status === 'legacy_pending') throw new Error('An incomplete legacy migration needs its original recovery review before stopping the instance')
  return preview
}
