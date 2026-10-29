import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const observed = vi.hoisted(() => ({ commands: [] }))
vi.mock('../../lib/toolchain.mjs', () => ({ ensureCorepack: async () => '/fixture/corepack.mjs' }))
vi.mock('../../lib/install-network.mjs', () => ({
  selectPackageSource: async () => ({ url: 'https://packages.example.invalid' }),
  packageEnvironment: () => ({}),
  nativePackageEnvironment: async (_root, _source, env) => env,
  withPackageSource: async (source, operation) => operation(source.url, {}, 10000),
}))
vi.mock('../../lib/scrapling-prepare.mjs', () => ({
  runBounded: async (command, args, options) => { observed.commands.push({ command, args, cwd: options.cwd }); return { code: 0 } },
}))
vi.mock('../../lib/memory-deps.mjs', () => ({ prepareMemoryDependencies: vi.fn() }))
import { runSourceUpgrade } from '../source.mjs'

let root
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-source-order-')); observed.commands.length = 0 })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
const logger = { info() {}, warn() {} }
it('builds the local SDK before root and consuming modules snapshot file dependencies', async () => {
  for (const name of ['crabot-client', 'crabot-shared', 'crabot-admin', 'crabot-admin/web', 'crabot-core']) await fs.mkdir(path.join(root, name), { recursive: true })
  await runSourceUpgrade(root, logger)
  const find = (directory, arguments_) => observed.commands.findIndex(call => call.cwd === path.join(root, directory) && arguments_.every(value => call.args.includes(value)))
  const install = find('crabot-client', ['install', '--frozen-lockfile'])
  const build = find('crabot-client', ['run', 'build'])
  expect(install).toBeGreaterThanOrEqual(0)
  expect(build).toBeGreaterThan(install)
  for (const directory of ['', 'crabot-core', 'crabot-admin', 'crabot-admin/web']) {
    expect(find(directory, ['install', '--frozen-lockfile'])).toBeGreaterThan(build)
  }
  expect(find('crabot-shared', ['run', 'build'])).toBeLessThan(find('crabot-admin', ['run', 'build']))
})
it('retains the original source preparation when no local SDK exists', async () => {
  await runSourceUpgrade(root, logger)
  expect(observed.commands[0].cwd).toBe(root)
  expect(observed.commands[0].args).toContain('install')
  expect(observed.commands.some(call => call.cwd === path.join(root, 'crabot-client'))).toBe(false)
})
