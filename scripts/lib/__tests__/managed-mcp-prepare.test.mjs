import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { managedMcpSelection, validateManagedMcp } = require('../managed-mcp-config.cjs')
const { prepareManagedMcp } = require('../managed-mcp-prepare.cjs')

test('managed selection applies only to a new standard bundled entry and explicit custom stays custom', () => {
  for (const [command, runtime] of [['npx', 'node'], ['uvx', 'python']]) {
    assert.equal(managedMcpSelection({ command }, true), runtime)
    assert.equal(managedMcpSelection({ command }, false), undefined)
    assert.equal(managedMcpSelection({ command, managed_runtime: null }, true), undefined)
    assert.equal(managedMcpSelection({ command, env: { MCP_TOKEN: 'own-token' } }, true), undefined)
  }
  for (const command of ['node', 'python', './npx', '/custom/bin/uvx']) assert.equal(managedMcpSelection({ command }, true), undefined)
})

test('custom configurations are untouched while a conflicting managed interpreter is rejected', () => {
  const custom = { command: '/own/python', env: { PATH: '/own/path' }, args: ['--python', 'own-python'] }
  assert.equal(managedMcpSelection(custom, true), undefined)
  assert.deepEqual(custom.env, { PATH: '/own/path' })
  for (const config of [
    { command: '/own/node', managed_runtime: 'node' },
    { command: 'uvx', managed_runtime: 'node' },
    { command: 'npx', managed_runtime: 'node', transport: 'sse' },
    { command: 'npx', managed_runtime: 'node', env: { NPM_CONFIG_CACHE: '/custom' } },
    { command: 'uvx', managed_runtime: 'python', env: { UV_PYTHON: '/custom' } },
    { command: 'uvx', managed_runtime: 'python', args: ['--python', 'host-python', 'tool'] },
    { command: 'npx', managed_runtime: 'node', args: ['--prefix=/custom', 'tool'] },
  ]) assert.throws(() => validateManagedMcp(config), /受管|自定义/)
  // These belong to the MCP's own argument parser, after the package target.
  validateManagedMcp({ command: 'uvx', managed_runtime: 'python', args: ['--from', 'project-package', 'tool', '--python', 'project-option'] })
  validateManagedMcp({ command: 'npx', managed_runtime: 'node', args: ['--package', 'project-package', 'tool', '--prefix', 'project-option'] })
})

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot MCP 环境 ')))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const files = {}, executables = {}, data = path.join(root, 'data')
  for (const name of ['node', 'python', 'uv', 'bash', 'git', 'rg']) {
    const relative = 'runtime/bin/' + name + (process.platform === 'win32' ? '.exe' : '')
    const content = Buffer.from('fixed command path fixture ' + name)
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await fs.writeFile(path.join(root, relative), content, { mode: 0o755 })
    files[relative] = { size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
    executables[name] = relative
  }
  for (const directory of ['runtime/python', 'runtime/memory', 'data']) await fs.mkdir(path.join(root, directory), { recursive: true })
  const manifest = { schema_version: 1, version: 'mcp-test', platform: process.platform, arch: process.arch,
    versions: { python: '3.12.12', node: '22.22.3' }, executables, path_entries: ['runtime/bin'],
    python_home: 'runtime/python', memory_packages: 'runtime/memory', seed_wheels: [], files }
  await fs.writeFile(path.join(root, 'product-runtime.json'), JSON.stringify(manifest))
  const npm = path.join(root, process.platform === 'win32' ? 'runtime/bin/node_modules/npm/bin' : 'runtime/lib/node_modules/npm/bin')
  await fs.mkdir(npm, { recursive: true })
  for (const command of ['npm', 'npx']) await fs.writeFile(path.join(npm, command + '-cli.js'), '// command path fixture; never executed')
  return { root, data, manifest, npm }
}

test('stable MCP IDs reuse dependency paths; another ID is isolated and no package command is executed', async t => {
  const f = await fixture(t), config = { id: 'stable-one', command: 'npx', managed_runtime: 'node', name: 'first', env: { MCP_TOKEN: 'own-token' } }
  const first = prepareManagedMcp(f.root, f.data, config)
  const same = prepareManagedMcp(f.root, f.data, { ...config, name: 'renamed' })
  const other = prepareManagedMcp(f.root, f.data, { ...config, id: '../../another-server' })
  assert.deepEqual(same, first)
  assert.equal(first.command, path.join(f.root, f.manifest.executables.node))
  assert.deepEqual(first.args, [path.join(f.npm, 'npx-cli.js')])
  assert.equal(first.env.MCP_TOKEN, undefined, 'Preparation never handles the MCP credential')
  assert.equal(first.env.NODE_OPTIONS, ''); assert.equal(first.env.NODE_PATH, '')
  assert.notEqual(first.env.npm_config_prefix, other.env.npm_config_prefix)
  assert.notEqual(first.env.npm_config_cache, other.env.npm_config_cache)
  assert.equal(first.command, other.command, 'Only the immutable interpreter is shared')
  for (const prepared of [first, other]) {
    const relative = path.relative(path.join(f.data, 'mcp-envs'), prepared.env.npm_config_prefix)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    assert.equal(prepared.env.NPM_CONFIG_PREFIX, prepared.env.npm_config_prefix)
    assert.equal(prepared.env.NPM_CONFIG_CACHE, prepared.env.npm_config_cache)
    assert.ok(prepared.env.npm_config_userconfig.startsWith(f.data + path.sep))
  }
  const retained = path.join(path.dirname(first.env.npm_config_prefix), 'retained-package')
  await fs.writeFile(retained, 'keep dependency data')
  prepareManagedMcp(f.root, f.data, config)
  assert.equal(await fs.readFile(retained, 'utf8'), 'keep dependency data')
})

test('a damaged bundled interpreter fails without clearing a prepared MCP environment', async t => {
  const f = await fixture(t), config = { id: 'retained', command: 'node', managed_runtime: 'node' }
  const prepared = prepareManagedMcp(f.root, f.data, config), retained = path.join(path.dirname(prepared.env.npm_config_prefix), 'retained')
  await fs.writeFile(retained, 'existing dependencies')
  await fs.writeFile(prepared.command, 'changed bundled interpreter')
  assert.throws(() => prepareManagedMcp(f.root, f.data, config), /完整性|integrity/)
  assert.equal(await fs.readFile(retained, 'utf8'), 'existing dependencies')
})
