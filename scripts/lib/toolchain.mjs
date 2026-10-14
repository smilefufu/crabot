import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { runBounded } from './run-bounded.mjs'
import { selectPackageSource, withPackageSource } from './install-network.mjs'

const windows = process.platform === 'win32'
const tools = windows ? join(process.env.LOCALAPPDATA || homedir(), 'crabot', 'corepack') : join(homedir(), '.local/share/crabot/corepack')
const entry = join(tools, 'node_modules/corepack/dist/corepack.js')
export async function ensureCorepack(root, { source, logger = console } = {}) {
  source ??= await selectPackageSource('npm', { logger })
  const run = (cmd, args, timeout = 20 * 60_000) => withPackageSource(source, (url, env, remaining) => runBounded(cmd, args, { cwd: root, env, timeout: remaining, captureError: true }), { logger, timeout })
  const system = windows ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'corepack pnpm@9.15.9 --version'] } : { command: 'corepack', args: ['pnpm@9.15.9', '--version'] }
  let missing = false
  if (windows) {
    try { execFileSync('where.exe', ['corepack'], { stdio: 'ignore', timeout: 5000 }) }
    catch (error) { if (error.status !== 1) throw error; missing = true }
  }
  try {
    if (missing) throw Object.assign(new Error('Corepack executable is missing'), { code: 'ENOENT' })
    await run(system.command, system.args, 60_000)
    return null
  } catch (error) {
    const failure = `${error.message}\n${error.stderr ?? ''}`
    if (error.code !== 'ENOENT' && !/Cannot find matching keyid|corepack[^\n]*(not found|not recognized)|不是内部或外部命令/i.test(failure)) throw error
    // Prepare the private tool without modifying the global installation.
  }
  if (!existsSync(entry)) {
    const args = ['install', '--prefix', tools, '--ignore-scripts', '--no-audit', '--no-fund', 'corepack@0.31.0']
    if (windows) {
      const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
      if (!existsSync(npm)) throw new Error('npm is missing from this Node installation; install the official Node.js toolchain and retry')
      await run(process.execPath, [npm, ...args])
    } else await run('npm', args)
  }
  await run(process.execPath, [entry, 'pnpm@9.15.9', '--version'], 60_000)
  if (!windows) {
    const bin = join(homedir(), '.local/bin')
    mkdirSync(bin, { recursive: true })
    try { symlinkSync(entry, join(bin, 'corepack')) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  return entry
}
