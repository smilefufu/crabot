import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runBounded } from './scrapling-prepare.mjs'

const legacy = { 'v2026.9.23': [], 'v2026.10.12.4': ['scrapling'] }
const components = {
  scrapling: ['scripts/prepare-scrapling.mjs', 'scripts/lib/scrapling-runtime.cjs', 'scripts/scrapling/runtime.json', 'scrapling-runtime.json'],
  'computer-use': ['scripts/prepare-computer-use.mjs', 'scripts/lib/computer-use-runtime.cjs', 'scripts/computer-use/runtime.json', 'crabot-mcp-tools/dist/computer-use/service.js'],
}
export async function verifyReleasePackage(root, version, { run = runBounded } = {}) {
  const required = ['cli.mjs', 'package.json', 'dist/cli/main.js', 'scripts/start.mjs', 'crabot-memory/pyproject.toml', 'crabot-memory/uv.lock']
  if (!Object.hasOwn(legacy, version)) required.push('scripts/check-release.mjs')
  for (const file of required) if (!existsSync(join(root, file))) throw new Error(`Release package missing ${file}`)
  const requestUpgradeFiles = ['crabot-agent/shared_request_version', 'crabot-agent/dist/manager/request-upgrade.js', 'crabot-admin/dist/shared-request-impact.js', 'scripts/prepare-shared-requests.mjs', 'scripts/upgrade-lib/shared-requests.mjs']
  if (requestUpgradeFiles.some(file => existsSync(join(root, file)))) {
    for (const file of requestUpgradeFiles) if (!existsSync(join(root, file))) throw new Error(`Release package incomplete: missing ${file}`)
  }
  if (existsSync(join(root, 'scripts/upgrade-lib/prepared-upgrade.mjs'))) {
    const scopedUpgradeFiles = ['crabot-agent/dist/manager/request-runtime-metadata.js', 'scripts/upgrade-lib/scoped-data.mjs', 'scripts/upgrade-lib/migration-transaction.mjs', 'scripts/upgrade-lib/preflight.mjs', 'scripts/upgrade-lib/shared-requests-v1.mjs', 'scripts/execute-scoped-migration.mjs', 'crabot-memory/upgrade/scope.mjs', 'crabot-memory/upgrade/scoped_upgrade.py']
    for (const file of scopedUpgradeFiles) if (!existsSync(join(root, file))) throw new Error(`Release package incomplete: missing ${file}`)
  }
  const dependencyHelpers = ['scripts/installer-deps.mjs', 'scripts/prepare-memory.mjs', 'scripts/lib/install-network.mjs', 'scripts/lib/memory-deps.mjs', 'scripts/lib/run-bounded.mjs']
  if (dependencyHelpers.some(file => existsSync(join(root, file)))) {
    for (const file of dependencyHelpers) if (!existsSync(join(root, file))) throw new Error(`Release package incomplete: missing ${file}`)
  }
  for (const [name, files] of Object.entries(components)) {
    if (Object.hasOwn(legacy, version) && !legacy[version].includes(name)) {
      if (files.some(file => existsSync(join(root, file)))) throw new Error(`Release package has mixed ${name} generation: ${version}`)
      continue
    }
    for (const file of files) if (!existsSync(join(root, file))) throw new Error(`Release package incomplete: missing ${file}`)
    await run(process.execPath, [join(root, files[0]), '--check'], { cwd: root, timeout: 120_000 })
  }
}
