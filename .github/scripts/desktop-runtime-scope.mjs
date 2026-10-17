import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'

// Native identity, control, SDK and UI checks always run. Rebuild the full interpreter/
// browser payload when its inputs or actual capability consumers change, or on manual final validation.
const prefixes = ['crabot-core/', 'crabot-memory/', 'crabot-shared/', 'crabot-mcp-tools/', 'crabot-native/', 'scripts/desktop/', 'scripts/scrapling/',
  'scripts/computer-use/', 'scripts/lib/product-', 'scripts/lib/scrapling-', 'scripts/lib/computer-use-',
  '.github/scripts/fixtures/product-']
const files = new Set(['scripts/prepare-product-runtime.mjs', 'scripts/prepare-scrapling.mjs', 'scripts/prepare-computer-use.mjs',
  'scripts/build-native.mjs', 'crabot-desktop/src/main.ts', 'crabot-desktop/src/controller.ts', 'crabot-desktop/src/session-host.ts',
  'scripts/run-product-memory.mjs', 'scripts/lib/install-network.mjs', 'scripts/lib/run-bounded.mjs', 'scripts/upgrade-lib/runner.mjs',
  '.github/scripts/smoke-product-runtime.mjs', 'crabot-agent/src/core/runtime-env.ts', 'crabot-agent/src/core/background-shell.ts',
  '.github/scripts/smoke-packaged-desktop.mjs', 'scripts/lib/desktop-cli-install.mjs', 'scripts/lib/version-maintenance.mjs', 'scripts/lib/cli-installation.mjs', 'scripts/lib/release-package.mjs', 'scripts/upgrade-lib/release.mjs',
  'crabot-agent/src/utils/resolve-bash-path.ts', 'crabot-agent/src/agent/mcp-connector.ts',
  'crabot-agent/package.json', 'crabot-agent/pnpm-lock.yaml', 'crabot-mcp-tools/package.json', 'crabot-mcp-tools/pnpm-lock.yaml'])
let full = true
const base = process.env.CRABOT_CI_BASE
if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && /^[a-f0-9]{40}$/.test(base ?? '') && !/^0+$/.test(base)) {
  try {
    try { execFileSync('git', ['cat-file', '-e', base + '^{commit}'], { stdio: 'ignore' }) }
    catch { execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base], { stdio: 'ignore' }) }
    const paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    full = paths.some(file => files.has(file) || prefixes.some(prefix => file.startsWith(prefix)))
  } catch { console.info('Runtime scope could not be established; run full capability validation') }
}
mkdirSync('.desktop-build', { recursive: true })
writeFileSync('.desktop-build/runtime-scope.json', JSON.stringify({ full_runtime: full }) + '\n')
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full_runtime=${full}\n`)
console.info('Full product runtime validation: ' + full)
