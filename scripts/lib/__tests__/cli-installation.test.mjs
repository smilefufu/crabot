import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareCliPayload, selectCliPayload, readCliSelection, locateCliInstallation } from '../cli-installation.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import management from '../desktop-management.cjs'

const windows = process.platform === 'win32', name = windows ? 'crabot.exe' : 'crabot'
async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot CLI 版本 ')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const installRoot = path.join(parent, '安装'), dataDir = management.ensurePrivateDataRoot(path.join(parent, '数据'))
  async function source(version) {
    const root = path.join(parent, '核心 ' + version)
    await fs.mkdir(path.join(root, 'bin'), { recursive: true })
    const node = path.join(root, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
    await fs.mkdir(path.dirname(node), { recursive: true })
    await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE)
    await fs.copyFile(new URL('../../../crabot-native/build/Release/' + name, import.meta.url), path.join(root, 'bin', name))
    if (!windows) { await fs.chmod(node, 0o755); await fs.chmod(path.join(root, 'bin/crabot'), 0o755) }
    await fs.writeFile(path.join(root, 'cli.mjs'), 'console.log(' + JSON.stringify(version) + ')')
    for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(root, file), JSON.stringify({ version }))
    await writeCoreRelease(root, { schema_version: 1, version, platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
    return root
  }
  return { parent, installRoot, dataDir, source }
}
async function choose(f, prepared, expected = null) {
  const lock = await acquireCliLock(f.dataDir, 'test-cli-select')
  try { await selectCliPayload(prepared, { dataDir: f.dataDir, expected }) } finally { releaseCliLock(lock) }
}

test('a CLI install and version switch share a stable native command while preserving old core and user data', async t => {
  const f = await fixture(t), one = await prepareCliPayload({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot })
  await fs.writeFile(path.join(f.dataDir, 'custom-environment'), 'keep this')
  assert.equal(readCliSelection(f.installRoot), null)
  await assert.rejects(selectCliPayload(one), { code: 'CRABOT_CLI_INSTALLATION' })
  await choose(f, one)
  assert.equal((await promisify(execFile)(one.command, ['--version'], { env: { ...process.env, PATH: '' } })).stdout.trim(), '1.2.3')
  assert.equal(locateCliInstallation(one.coreRoot).selected, true)
  const two = await prepareCliPayload({ sourceRoot: await f.source('1.2.4'), installRoot: f.installRoot })
  assert.equal(readCliSelection(f.installRoot), one.id)
  assert.equal((await promisify(execFile)(one.command, [])).stdout.trim(), '1.2.3')
  await choose(f, two, one.id)
  assert.equal(two.command, one.command)
  assert.equal((await promisify(execFile)(one.command, [])).stdout.trim(), '1.2.4')
  assert.equal(locateCliInstallation(one.coreRoot).selected, false)
  assert.equal((await verifyCoreRelease(one.coreRoot)).version, '1.2.3')
  assert.equal((await verifyCoreRelease(two.coreRoot)).version, '1.2.4')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'custom-environment'), 'utf8'), 'keep this')
})

test('a changed target or stale selection cannot replace the known current version', async t => {
  const f = await fixture(t), one = await prepareCliPayload({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot })
  await choose(f, one)
  const two = await prepareCliPayload({ sourceRoot: await f.source('1.2.4'), installRoot: f.installRoot })
  await assert.rejects(choose(f, two, 'b'.repeat(64)), { code: 'CRABOT_CLI_INSTALLATION' })
  await fs.appendFile(path.join(two.coreRoot, 'cli.mjs'), '\n// damaged')
  await assert.rejects(choose(f, two, one.id), { code: 'CRABOT_CORE_INTEGRITY' })
  assert.equal(readCliSelection(f.installRoot), one.id)
})

test('legacy and desktop installations cannot be silently replaced by a standalone CLI payload', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  await fs.mkdir(f.installRoot); await fs.writeFile(path.join(f.installRoot, 'cli.mjs'), 'old custom entry')
  await assert.rejects(prepareCliPayload({ sourceRoot, installRoot: f.installRoot }), { code: 'CRABOT_CLI_INSTALLATION' })
  assert.equal(await fs.readFile(path.join(f.installRoot, 'cli.mjs'), 'utf8'), 'old custom entry')
  await fs.writeFile(path.join(sourceRoot, 'desktop-host.json'), '{}')
  await assert.rejects(prepareCliPayload({ sourceRoot, installRoot: path.join(f.parent, 'another') }), { code: 'CRABOT_CLI_INSTALLATION' })
})


test('retained CLI code refuses bootstrap before dependency loading when a newer version is selected', async t => {
  const f = await fixture(t), one = await prepareCliPayload({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot })
  await choose(f, one)
  const two = await prepareCliPayload({ sourceRoot: await f.source('1.2.4'), installRoot: f.installRoot })
  await choose(f, two, one.id)
  // Replace only this disposable fixture's script with the real CLI bootstrap.
  // No preflight/dependencies/native addon are copied: stale code must stop first.
  await fs.copyFile(new URL('../../../cli.mjs', import.meta.url), path.join(one.coreRoot, 'cli.mjs'))
  await fs.mkdir(path.join(one.coreRoot, 'scripts/lib'), { recursive: true })
  await fs.copyFile(new URL('../cli-location.cjs', import.meta.url), path.join(one.coreRoot, 'scripts/lib/cli-location.cjs'))
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(one.coreRoot, 'cli.mjs'), 'start']), error => {
    assert.equal(error.code, 1); assert.match(error.stderr, /此核心已不是当前版本/); assert.doesNotMatch(error.stderr, /MODULE_NOT_FOUND/); return true
  })
})
