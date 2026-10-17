import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, rename, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { loadProductRuntime, productEnvironment } = require('../product-runtime.cjs')

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'crabot-product-runtime-')))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, '安装 包')
  await mkdir(root)
  const files = {}
  const executables = {}
  for (const name of ['node', 'python', 'uv', 'bash', 'git', 'rg']) {
    const relative = 'runtime/bin/' + name + (process.platform === 'win32' ? '.exe' : '')
    const content = Buffer.from('fixture executable ' + name)
    await mkdir(dirname(join(root, relative)), { recursive: true })
    await writeFile(join(root, relative), content, { mode: 0o755 })
    files[relative] = { size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
    executables[name] = relative
  }
  await mkdir(join(root, 'runtime/python'), { recursive: true })
  await mkdir(join(root, 'runtime/memory'), { recursive: true })
  const manifest = {
    schema_version: 1, version: 'desktop-test', platform: process.platform, arch: process.arch,
    versions: { python: '3.12.12', node: '22.22.3' },
    executables, path_entries: ['runtime/bin'], python_home: 'runtime/python',
    memory_packages: 'runtime/memory', seed_wheels: [], files,
  }
  const save = () => writeFile(join(root, 'product-runtime.json'), JSON.stringify(manifest))
  await save()
  return { parent, root, manifest, save }
}

test('source installs stay optional; a sealed installation cannot silently become source mode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crabot-source-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(loadProductRuntime(root), null)
  assert.throws(() => loadProductRuntime(root, { required: true }), /内置运行环境|runtime/i)
  await mkdir(join(root, '.product-runtime'))
  assert.throws(() => loadProductRuntime(root), /清单缺失/)
})

test('the same manifest works after relocating a Chinese and spaced install path', async t => {
  const f = await fixture(t)
  const moved = join(f.parent, '移动 后')
  await rename(f.root, moved)
  const runtime = loadProductRuntime(moved, { full: true })
  assert.equal(runtime.executables.node, join(moved, f.manifest.executables.node))
  assert.equal(runtime.root, moved)
})

test('a malformed manifest or incompatible native platform fails closed', async t => {
  const f = await fixture(t)
  f.manifest.platform = process.platform === 'win32' ? 'darwin' : 'win32'
  await f.save()
  assert.throws(() => loadProductRuntime(f.root), /platform|平台/i)
  await writeFile(join(f.root, 'product-runtime.json'), '{')
  assert.throws(() => loadProductRuntime(f.root), /manifest|清单/i)
})

test('absolute, traversal, Windows drive and separator tricks cannot escape the install', async t => {
  const f = await fixture(t)
  for (const relative of ['/tmp/node', '../node', 'runtime/../../node', 'C:/node.exe', 'runtime\\..\\node', './runtime/bin/node']) {
    f.manifest.executables.node = relative
    await f.save()
    assert.throws(() => loadProductRuntime(f.root), /path|路径|manifest|清单/i, relative)
  }
})

test('a symlink to another installation is rejected even when its hash matches', async t => {
  const f = await fixture(t)
  const outside = join(f.parent, 'outside-bin')
  const target = join(f.root, 'runtime/bin')
  await rename(target, outside)
  await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => loadProductRuntime(f.root, { full: true }), /path|路径|outside|越界/i)
})

test('required commands must be inventoried; missing or same-size corrupt resources are rejected', async t => {
  const f = await fixture(t)
  const entry = f.manifest.executables.node
  const original = f.manifest.files[entry]
  delete f.manifest.files[entry]
  await f.save()
  assert.throws(() => loadProductRuntime(f.root), /inventory|清单/i)
  f.manifest.files[entry] = original
  await f.save()
  await writeFile(join(f.root, entry), Buffer.alloc(original.size, 120))
  assert.throws(() => loadProductRuntime(f.root), /integrity|完整性/i)
  await rm(join(f.root, entry))
  assert.throws(() => loadProductRuntime(f.root), /missing|缺失/i)
})

test('full verification catches dependency damage beyond command entrypoints', async t => {
  const f = await fixture(t)
  const entry = 'runtime/memory/package.py'
  await writeFile(join(f.root, entry), 'before')
  f.manifest.files[entry] = { size: 6, sha256: createHash('sha256').update('before').digest('hex') }
  await f.save()
  await writeFile(join(f.root, entry), 'after!')
  assert.throws(() => loadProductRuntime(f.root, { full: true }), /integrity|完整性/i)
})

test('product PATH and caches are private without altering Worker CLI install policy or caller env', async t => {
  const f = await fixture(t)
  const runtime = loadProductRuntime(f.root)
  const source = { PATH: 'host-bin', npm_config_prefix: '/explicit/user/prefix', CUSTOM: 'kept' }
  const env = productEnvironment(runtime, join(f.parent, 'data'), source)
  assert.equal(env.PATH, join(f.root, 'runtime/bin') + delimiter + 'host-bin')
  assert.equal(env.npm_config_cache, join(f.parent, 'data', 'runtime-cache', 'npm'))
  assert.equal(env.npm_config_prefix, source.npm_config_prefix)
  assert.equal(env.CUSTOM, 'kept')
  assert.deepEqual(source, { PATH: 'host-bin', npm_config_prefix: '/explicit/user/prefix', CUSTOM: 'kept' })
  assert.equal(env.CRABOT_BASH_PATH, runtime.executables.bash)
  assert.equal(env.PYTHONUTF8, '1')
  assert.equal(env.PYTHONIOENCODING, 'utf-8')
  const explicit = productEnvironment(runtime, join(f.parent, 'data'), { PYTHONUTF8: '0', PYTHONIOENCODING: 'latin1' })
  assert.equal(explicit.PYTHONUTF8, '0'); assert.equal(explicit.PYTHONIOENCODING, 'latin1')
})
