import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ChannelPackageStore, CHANNEL_NPM_REGISTRY } from './channel-package.js'
const definition = { name: 'crabot-channel-feishu', version: '0.1.0' }
const directories: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-package-'))
  directories.push(directory)
  return { directory, store: new ChannelPackageStore(directory) }
}
async function writePackage(stage: string) {
  const module = path.join(stage, 'node_modules', definition.name)
  await fs.mkdir(path.join(module, 'dist'), { recursive: true })
  await fs.writeFile(path.join(module, 'package.json'), JSON.stringify({ ...definition, main: 'dist/main.js' }))
  await fs.writeFile(path.join(module, 'dist/main.js'), 'exports.apply=()=>{};exports.createConfig=()=>({})')
  await fs.writeFile(path.join(module, 'crabot-module.yaml'), 'module_id: channel-feishu')
}

describe('instance-owned npm Channel packages', () => {
  it('deduplicates installation, fixes domestic registry and cache, then restarts offline from the installed package', async () => {
    const { directory, store } = await fixture()
    vi.stubEnv('CRABOT_JWT_SECRET', 'synthetic-private-secret')
    vi.stubEnv('NODE_OPTIONS', '--require synthetic-private-preload')
    const execute = vi.fn(async (command: string, args: string[], options: any) => {
      expect(command).toBe(process.execPath)
      expect(args[args.indexOf('--registry') + 1]).toBe(CHANNEL_NPM_REGISTRY)
      expect(args[args.indexOf('--cache') + 1]).toBe(path.join(directory, '.npm-cache'))
      expect(args).toContain('--ignore-scripts')
      expect(args.at(-1)).toBe('crabot-channel-feishu@0.1.0')
      expect(options.env.npm_config_registry).toBeUndefined()
      expect(options.env.CRABOT_JWT_SECRET).toBeUndefined()
      expect(options.env.NODE_OPTIONS).toBeUndefined()
      const stage = args[args.indexOf('--prefix') + 1]
      expect(await fs.readFile(path.join(stage, 'user.npmrc'), 'utf8')).toBe('')
      await writePackage(stage)
      await fs.writeFile(path.join(stage, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/example': { resolved: CHANNEL_NPM_REGISTRY + '/example/-/example-1.0.0.tgz' } } }))
      return { stdout: '', stderr: 'npm http fetch GET 200 https://cdn.npmmirror.com/packages/example.tgz' }
    })
    const first = store.ensure(definition, { execute: execute as any })
    const second = store.ensure(definition, { execute: execute as any })
    expect(first).toBe(second)
    const installed = await first
    expect(installed).toBe(store.packagePath(definition))
    expect(execute).toHaveBeenCalledOnce()
    const restarted = new ChannelPackageStore(directory)
    expect(await restarted.ensure(definition, { execute: vi.fn() as any })).toBe(installed)
  })

  it('retains cache and an older package while cleaning a failed staging directory', async () => {
    const { directory, store } = await fixture()
    const old = { ...definition, version: '0.0.9' }
    const older = path.dirname(path.dirname(store.packagePath(old)))
    await fs.mkdir(older, { recursive: true }); await fs.writeFile(path.join(older, 'retained'), 'older version')
    const execute = vi.fn(async (_command: string, args: string[]) => {
      await fs.writeFile(path.join(directory, '.npm-cache', 'downloaded'), 'cache remains')
      throw new Error('synthetic network failure')
    })
    await expect(store.ensure(definition, { execute: execute as any })).rejects.toThrow('缓存已保留')
    expect(await fs.readFile(path.join(directory, '.npm-cache/downloaded'), 'utf8')).toBe('cache remains')
    expect(await fs.readFile(path.join(older, 'retained'), 'utf8')).toBe('older version')
    expect((await fs.readdir(path.join(directory, definition.name))).some(name => name.startsWith('.install-'))).toBe(false)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects dependency downloads that escape the domestic registry', async () => {
    const { store } = await fixture()
    const execute = vi.fn(async (_command: string, args: string[]) => {
      const stage = args[args.indexOf('--prefix') + 1]
      await writePackage(stage)
      await fs.writeFile(path.join(stage, 'package-lock.json'), JSON.stringify({ packages: { bad: { resolved: 'https://registry.npmjs.org/bad.tgz' } } }))
      return { stdout: '', stderr: '' }
    })
    await expect(store.ensure(definition, { execute: execute as any })).rejects.toThrow('安装失败')
    expect(await store.installed(definition)).toBeUndefined()
  })
})
