import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const observed = vi.hoisted(() => ({ commands: [], failElectron: false }))
vi.mock('../../lib/toolchain.mjs', () => ({ ensureCorepack: async () => '/fixture/corepack.mjs' }))
vi.mock('../../lib/install-network.mjs', () => ({
  selectPackageSource: async () => ({ url: 'https://packages.example.invalid' }),
  packageEnvironment: () => ({}),
  nativePackageEnvironment: async (_root, _source, env) => env,
  withPackageSource: async (source, operation) => operation(source.url, {}, 10000),
}))
vi.mock('../../lib/scrapling-prepare.mjs', () => ({
  runBounded: async (command, args, options) => {
    observed.commands.push({ command, args, cwd: options.cwd })
    if (observed.failElectron && args.includes("require('electron')")) throw new Error('Electron download failed')
    return { code: 0 }
  },
}))
vi.mock('../../lib/memory-deps.mjs', () => ({ prepareMemoryDependencies: vi.fn() }))
import { runSourceUpgrade } from '../source.mjs'

let root
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-source-order-')); observed.commands.length = 0; observed.failElectron = false })
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

it('developer preparation reuses verified outputs and refreshes file consumers after SDK changes', async () => {
  for (const name of ['crabot-client', 'crabot-shared', 'crabot-core', 'crabot-admin', 'crabot-admin/web', 'crabot-desktop']) {
    const directory = path.join(root, name)
    await fs.mkdir(path.join(directory, 'src'), { recursive: true })
    await fs.mkdir(name === 'crabot-admin/web' ? path.join(directory, '../dist/web') : path.join(directory, 'dist'), { recursive: true })
    await fs.writeFile(path.join(directory, 'package.json'), '{}')
  }
  await fs.mkdir(path.join(root, 'dist/cli'), { recursive: true }); await fs.writeFile(path.join(root, 'dist/cli/main.js'), '')
  await runSourceUpgrade(root, logger, { incremental: true })
  expect(observed.commands.some(call => call.cwd === path.join(root, 'crabot-desktop'))).toBe(false)
  observed.commands.length = 0
  await runSourceUpgrade(root, logger, { incremental: true })
  expect(observed.commands.some(call => call.args.includes('install') || call.args.includes('build') || call.args.includes('build:cli'))).toBe(false)
  await fs.writeFile(path.join(root, 'crabot-client/src/new.ts'), 'export const added = true')
  observed.commands.length = 0
  await runSourceUpgrade(root, logger, { incremental: true, desktop: true })
  const find = directory => observed.commands.findIndex(call => call.cwd === path.join(root, directory) && call.args.includes('install'))
  expect(find('crabot-client')).toBeGreaterThanOrEqual(0)
  expect(find('crabot-core')).toBeGreaterThan(find('crabot-client'))
  expect(find('crabot-desktop')).toBeGreaterThan(find('crabot-core'))
  expect(observed.commands.filter(call => call.args.includes('install')).every(call => call.args.includes('--force'))).toBe(true)
})

it('explicit GUI preparation finishes the actual lazy Electron install and propagates its failure', async () => {
  const desktopDir = path.join(root, 'crabot-desktop')
  await fs.mkdir(desktopDir)
  observed.failElectron = true
  await expect(runSourceUpgrade(root, logger, { incremental: true, desktop: true })).rejects.toThrow('Electron download failed')
  const probe = observed.commands.find(call => call.args.includes("require('electron')"))
  expect(probe.command).toBe(process.execPath)
  expect(probe.cwd).toBe(desktopDir)
  expect(observed.commands.some(call => call.args.some(value => value.endsWith('prepare-scrapling.mjs')))).toBe(false)
})
