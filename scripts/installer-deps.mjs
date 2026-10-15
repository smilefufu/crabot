// Standalone installer helper: built-ins only, including when repairing a legacy release.
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { ensureCorepack } from './lib/toolchain.mjs'
import { prepareMemoryDependencies } from './lib/memory-deps.mjs'
import { packageSource, selectPackageSource, withPackageSource, nativePackageEnvironment } from './lib/install-network.mjs'
import { runBounded } from './lib/run-bounded.mjs'

const [mode, directory, encodedContext, ...args] = process.argv.slice(2)
const root = resolve(directory)
const logger = { info: message => console.error(`[crabot] ${message}`), warn: message => console.error(`[crabot] ${message}`) }
if (mode === 'memory') {
  await prepareMemoryDependencies(root, { logger, dev: encodedContext === '--dev' || args.includes('--dev') })
} else if (mode === 'pnpm') {
  const context = encodedContext && encodedContext !== '-' ? JSON.parse(Buffer.from(encodedContext, 'base64').toString('utf8')) : null
  if (!args.length || args.some(arg => !['--version', 'install', '--prod', '--frozen-lockfile', '--prefer-offline'].includes(arg))) throw new Error('Unexpected installer pnpm arguments')
  const source = context ? packageSource('npm', context.registry) : await selectPackageSource('npm', { logger })
  const corepack = context ? context.corepack : await ensureCorepack(root, { source, logger })
  if (corepack) {
    const expected = join(process.platform === 'win32' ? (process.env.LOCALAPPDATA || homedir()) : join(homedir(), '.local/share'), 'crabot/corepack/node_modules/corepack/dist/corepack.js')
    if (resolve(corepack) !== resolve(expected)) throw new Error('Unexpected installer Corepack path')
  }
  await withPackageSource(source, async (url, env, remaining) => {
    const deadline = Date.now() + remaining
    if (args.includes('install')) env = await nativePackageEnvironment(root, source, env, logger)
    remaining = Math.max(1, deadline - Date.now())
    if (corepack) return runBounded(process.execPath, [corepack, 'pnpm@9.15.9', ...args], { cwd: root, env, timeout: remaining, captureError: true })
    if (process.platform === 'win32') return runBounded('cmd.exe', ['/d', '/s', '/c', `corepack pnpm@9.15.9 ${args.join(' ')}`], { cwd: root, env, timeout: remaining, captureError: true })
    return runBounded('corepack', ['pnpm@9.15.9', ...args], { cwd: root, env, timeout: remaining, captureError: true })
  }, { logger })
  const result = Buffer.from(JSON.stringify({ corepack, registry: source.url })).toString('base64')
  process.stdout.write(`\nCRABOT_TOOL_RESULT=${result}\n`)
} else throw new Error(`Unknown installer dependency stage: ${mode}`)
