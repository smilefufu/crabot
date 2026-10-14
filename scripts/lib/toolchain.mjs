import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { runBounded } from './scrapling-prepare.mjs'

const windows = process.platform === 'win32'
const tools = windows ? join(process.env.LOCALAPPDATA || homedir(), 'crabot', 'corepack') : join(homedir(), '.local/share/crabot/corepack')
const entry = join(tools, 'node_modules/corepack/dist/corepack.js')
export async function ensureCorepack(root) {
  const system = windows ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'corepack pnpm@9.15.9 --version'] } : { command: 'corepack', args: ['pnpm@9.15.9', '--version'] }
  try {
    await runBounded(system.command, system.args, { cwd: root, timeout: 60_000 })
    return null
  } catch (error) {
    if (error.code === 'CRABOT_PREPARATION_CANCELLED') throw error
    // Prepare the private tool without modifying the global installation.
  }
  if (!existsSync(entry)) {
    const args = ['install', '--prefix', tools, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', 'corepack@0.31.0']
    if (windows) {
      const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
      if (!existsSync(npm)) throw new Error('npm is missing from this Node installation; install the official Node.js toolchain and retry')
      await runBounded(process.execPath, [npm, ...args], { cwd: root })
    } else await runBounded('npm', args, { cwd: root })
  }
  await runBounded(process.execPath, [entry, 'pnpm@9.15.9', '--version'], { cwd: root, timeout: 60_000 })
  if (!windows) {
    const bin = join(homedir(), '.local/bin')
    mkdirSync(bin, { recursive: true })
    try { symlinkSync(entry, join(bin, 'corepack')) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  return entry
}
