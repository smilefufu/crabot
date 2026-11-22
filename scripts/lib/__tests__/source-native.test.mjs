import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import identity from '../process-identity.cjs'
import nativeBuild from '../native-build.cjs'
import { prepareSourceNative, verifySourceNative } from '../source-native.mjs'
import { desktopMaintenanceBootstrap } from '../desktop-maintenance-bootstrap.mjs'

const exec = promisify(execFile), product = fileURLToPath(new URL('../../../', import.meta.url))
const git = (root, args) => exec('git', args, { cwd: root })
const commit = async root => {
  await git(root, ['add', '.'])
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
}
async function fixture(t) {
  let root
  if (process.platform === 'win32') {
    root = path.join(await fs.realpath(process.env.RUNNER_TEMP || tmpdir()), 'n-' + randomUUID())
    identity.createPrivateDirectory(root)
  } else root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'n-')))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await fs.cp(path.join(product, 'scripts'), path.join(root, 'scripts'), { recursive: true,
    filter: name => !['node_modules', '__tests__'].includes(path.basename(name)) })
  await fs.cp(path.join(product, 'crabot-native/src'), path.join(root, 'crabot-native/src'), { recursive: true })
  for (const name of ['cli.mjs', 'package.json', '.gitignore']) await fs.copyFile(path.join(product, name), path.join(root, name))
  await fs.mkdir(path.join(root, '.desktop-build/native'), { recursive: true })
  // Pinned archives only. The actual entry must compile its own addon, never receive one.
  for (const name of await fs.readdir(path.join(product, '.desktop-build/native'))) {
    if (name.endsWith('.tar.gz') || name.endsWith('node.lib')) await fs.copyFile(path.join(product, '.desktop-build/native', name), path.join(root, '.desktop-build/native', name), constants.COPYFILE_FICLONE)
  }
  await git(root, ['init', '-q']); await commit(root)
  return root
}

test('actual source CLI and Web wrappers bootstrap from zero addon, preserve live files and reuse an isolated helper', { timeout: 180000 }, async t => {
  const root = await fixture(t), data = path.join(root, 'data')
  await fs.mkdir(data); await fs.writeFile(path.join(data, 'mm.pid'), String(process.pid))
  await fs.writeFile(path.join(data, 'business'), 'keep business')
  await fs.mkdir(path.join(root, 'dist')); await fs.writeFile(path.join(root, 'dist/live'), 'old program')
  for (const name of ['upgrade', 'ui-upgrade']) {
    await fs.writeFile(path.join(root, `scripts/${name}-main.mjs`), `
      import identity from './lib/process-identity.cjs';
      import{existsSync}from'node:fs';
      if(existsSync(new URL('../crabot-native/build/Release/crabot-native.node',import.meta.url)))throw Error('in-place native build');
      console.log(JSON.stringify({pid:identity.inspectProcess(process.pid).pid,data:process.env.DATA_DIR}));
    `)
  }
  await commit(root)
  const { stdout } = await exec(process.execPath, [path.join(root, 'cli.mjs'), 'upgrade', '--yes'], { cwd: root, env: { ...process.env, DATA_DIR: data }, timeout: 150000 })
  assert.match(stdout, /preparing isolated native helper/)
  assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)).data, data)
  const signature = nativeBuild.nativeSignature(root), directory = nativeBuild.bootstrapDirectory(root, signature)
  const addon = nativeBuild.resolveNative(root)
  assert.equal(addon, path.join(directory, 'crabot-native.node'))
  const before = await fs.stat(addon)
  const web = await exec(process.execPath, [path.join(root, 'scripts/ui-upgrade.mjs')], { cwd: root, env: { ...process.env, DATA_DIR: data }, timeout: 30000 })
  assert.doesNotMatch(web.stdout, /preparing isolated native helper/)
  assert.equal((await fs.stat(addon)).mtimeMs, before.mtimeMs)
  assert.equal(await fs.readFile(path.join(root, 'dist/live'), 'utf8'), 'old program')
  assert.equal(await fs.readFile(path.join(data, 'business'), 'utf8'), 'keep business')
  assert.equal(await fs.readFile(path.join(data, 'mm.pid'), 'utf8'), String(process.pid))
  assert.equal((await git(root, ['status', '--porcelain'])).stdout, '')
  // The upgrade process must not pin the target DLL on Windows.
  const standard = nativeBuild.standardDirectory(root)
  await fs.cp(nativeBuild.standardDirectory(product), standard, { recursive: true })
  const holder = spawn(process.execPath, ['-e', 'require(process.argv[1]);process.send("loaded");process.on("message",()=>process.exit(0))',
    path.join(root, 'scripts/lib/process-identity.cjs')], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  t.after(() => { if (holder.exitCode === null) holder.kill() })
  await once(holder, 'message', { signal: AbortSignal.timeout(30000) })
  await fs.rename(standard, standard + '-old')
  await fs.cp(nativeBuild.standardDirectory(product), standard, { recursive: true })
  await fs.rm(standard + '-old', { recursive: true })
  const exited = once(holder, 'exit'); holder.send('done'); await exited
  await fs.rm(standard, { recursive: true })
  // Tampering is detected before executing the candidate; read-only loaders never rebuild.
  await fs.appendFile(addon, 'tamper')
  assert.throws(() => nativeBuild.resolveNative(root), /crabot upgrade/)
  await assert.rejects(verifySourceNative(root, directory), /损坏/)
})

test('concurrent native bootstrap publishes one complete immutable generation', { timeout: 180000 }, async t => {
  const root = await fixture(t)
  await Promise.all([prepareSourceNative(root), prepareSourceNative(root)])
  const directory = nativeBuild.bootstrapDirectory(root, nativeBuild.nativeSignature(root))
  await verifySourceNative(root, directory)
  assert.deepEqual((await fs.readdir(path.dirname(directory))).filter(name => name.startsWith('.preparing-')), [])
  assert.equal(await fs.stat(nativeBuild.standardDirectory(root)).then(() => true, () => false), false)
})

test('native compilation failure is reported before main, leaves the running installation alone and cleans only its temporary output', { timeout: 180000 }, async t => {
  const root = await fixture(t)
  await fs.appendFile(path.join(root, 'crabot-native/src/identity.cc'), '\n#error source_native_failure_fixture\n')
  await fs.writeFile(path.join(root, 'scripts/upgrade-main.mjs'), 'throw Error("must not enter upgrade main")')
  await commit(root)
  const standard = nativeBuild.standardDirectory(root)
  await fs.mkdir(standard, { recursive: true }); await fs.writeFile(path.join(standard, 'crabot-native.node'), 'old component')
  await assert.rejects(exec(process.execPath, [path.join(root, 'scripts/upgrade.mjs'), '--yes'], { cwd: root, timeout: 150000 }), error => {
    assert.match(error.stdout + error.stderr, /source_native_failure_fixture/)
    assert.doesNotMatch(error.stdout + error.stderr, /must not enter upgrade main/)
    return error.code === 1
  })
  assert.equal(await fs.readFile(path.join(standard, 'crabot-native.node'), 'utf8'), 'old component')
  assert.deepEqual(await fs.readdir(path.join(root, '.desktop-build/upgrade-native')), [])
  const data = path.join(root, 'data')
  await assert.rejects(exec(process.execPath, [path.join(root, 'scripts/ui-upgrade.mjs')], {
    cwd: root, env: { ...process.env, DATA_DIR: data }, timeout: 150000,
  }))
  const status = JSON.parse(await fs.readFile(path.join(data, 'admin/upgrade-status.json'), 'utf8'))
  assert.equal(status.phase, 'failed'); assert.match(status.error, /准备阶段失败，服务未停/)
})

test('dirty sources and escaped caches cannot bootstrap; sealed installations never compile', { timeout: 30000 }, async t => {
  const root = await fixture(t)
  await fs.appendFile(path.join(root, 'crabot-native/src/identity.cc'), '\n// uncommitted')
  await assert.rejects(prepareSourceNative(root), /uncommitted/)
  await commit(root)
  const foreign = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'n-'))
  t.after(() => fs.rm(foreign, { recursive: true, force: true }))
  await fs.symlink(foreign, path.join(root, '.desktop-build/upgrade-native'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareSourceNative(root), /归属|写权限/)
  assert.deepEqual(await fs.readdir(foreign), [])
  await fs.writeFile(path.join(root, 'core-release.json'), '{}')
  await prepareSourceNative(root)
  assert.equal(nativeBuild.resolveNative(root), path.join(nativeBuild.standardDirectory(root), 'crabot-native.node'))
})

test('standard native receipts bind every runtime output and source/Node/compiler inputs', { timeout: 30000 }, async t => {
  const root = await fixture(t), directory = nativeBuild.standardDirectory(root)
  await fs.mkdir(directory, { recursive: true })
  for (const name of nativeBuild.nativeFiles()) await fs.copyFile(path.join(nativeBuild.standardDirectory(product), name), path.join(directory, name))
  const signature = nativeBuild.nativeSignature(root)
  nativeBuild.writeNativeReceipt(root, directory, signature)
  await verifySourceNative(root)
  for (const electron of [true, false]) {
    const module = { exports: {} }
    vm.runInNewContext(await fs.readFile(path.join(product, 'scripts/lib/native-build.cjs'), 'utf8'), {
      module, require: createRequire(import.meta.url),
      process: { platform: process.platform, arch: process.arch, version: 'v99.0.0', versions: electron ? { electron: 'fixture' } : {},
        env: process.env, getuid: process.getuid },
    })
    if (electron) assert.equal(module.exports.resolveNative(root), path.join(directory, 'crabot-native.node'))
    else assert.throws(() => module.exports.resolveNative(root), /crabot upgrade/)
  }
  await fs.appendFile(path.join(root, 'crabot-native/src/identity.cc'), '\n// changed')
  assert.notEqual(nativeBuild.nativeSignature(root), signature)
  assert.equal(nativeBuild.nativeReady(root, directory), false)
})

test('fixed maintenance bootstrap carries the native loader and loads without any source tree or compiler', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'n-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const name of desktopMaintenanceBootstrap.filter(name => /\/(process-identity|native-build)\.cjs$/.test(name))) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.copyFile(path.join(product, name), path.join(root, name))
  }
  const directory = nativeBuild.standardDirectory(root)
  await fs.mkdir(directory, { recursive: true })
  await fs.copyFile(path.join(nativeBuild.standardDirectory(product), 'crabot-native.node'), path.join(directory, 'crabot-native.node'))
  const { stdout } = await exec(process.execPath, ['-e', 'console.log(require(process.argv[1]).inspectProcess(process.pid).pid)', path.join(root, 'scripts/lib/process-identity.cjs')])
  assert.ok(Number(stdout.trim()) > 0)
  assert.equal(await fs.stat(path.join(root, '.desktop-build')).then(() => true, () => false), false)
})
