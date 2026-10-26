import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
import { applyPreparedCliUpgrade, prepareDownloadedCliUpgrade } from '../standalone-cli-release.mjs'
import { applyStoppedCliUpgrade } from '../standalone-cli-upgrade.mjs'
import { readVersionMaintenance, assertVersionMaintenanceAllowsStart } from '../version-maintenance.mjs'
import { verifyBackup } from '../../upgrade-lib/scoped-data.mjs'
import { inspectInstance } from '../instance-runtime.mjs'
import { installStandaloneCli } from '../standalone-cli-install.mjs'

const bundledNodeHash = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
const windows = process.platform === 'win32', name = windows ? 'crabot.exe' : 'crabot'
async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot CLI 版本 ')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const installRoot = path.join(parent, '安装'), dataDir = management.ensurePrivateDataRoot(path.join(parent, '数据'))
  async function source(version, extraFiles = {}) {
    const root = path.join(parent, '核心 ' + version)
    await fs.mkdir(path.join(root, 'bin'), { recursive: true })
    const node = path.join(root, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
    await fs.mkdir(path.dirname(node), { recursive: true })
    await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE)
    await fs.copyFile(new URL('../../../crabot-native/build/Release/' + name, import.meta.url), path.join(root, 'bin', name))
    if (!windows) { await fs.chmod(node, 0o755); await fs.chmod(path.join(root, 'bin/crabot'), 0o755) }
    await fs.writeFile(path.join(root, 'cli.mjs'), 'console.log(' + JSON.stringify(version) + ')')
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version }))
    // This fixture runs only Node migrations. Other command slots share the verified binary and are never executed.
    const relativeNode = path.relative(root, node).split(path.sep).join('/')
    const directory = path.posix.dirname(relativeNode)
    await fs.writeFile(path.join(root, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version,
      platform: process.platform, arch: process.arch, versions: { node: process.versions.node, python: '3.12.12' },
      executables: Object.fromEntries(['node', 'python', 'uv', 'bash', 'git', 'rg'].map(name => [name, relativeNode])),
      path_entries: [directory], python_home: directory, memory_packages: directory, seed_wheels: [],
      files: { [relativeNode]: { size: (await fs.stat(node)).size, sha256: bundledNodeHash } } }))
    for (const [file, content] of Object.entries(extraFiles)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await fs.writeFile(path.join(root, file), content)
    }
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


test('standalone fresh and repeated installs use one payload, never start a service, and refuse an implicit upgrade', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  const installed = await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })
  assert.equal(readCliSelection(f.installRoot), installed.id)
  assert.equal((await promisify(execFile)(installed.command, [])).stdout.trim(), '1.2.3')
  assert.equal((await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })).id, installed.id)
  await assert.rejects(fs.lstat(path.join(f.dataDir, 'mm.pid')), { code: 'ENOENT' })
  await assert.rejects(installStandaloneCli({ sourceRoot: await f.source('1.2.4'), installRoot: f.installRoot, dataDir: f.dataDir }), /crabot upgrade/)
  assert.equal(readCliSelection(f.installRoot), installed.id)
})

test('unclaimed business data and desktop data are preserved before standalone installer writes any code', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  await fs.writeFile(path.join(f.dataDir, 'existing-business'), 'keep this')
  await assert.rejects(installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir }), /旧安装迁移/)
  await assert.rejects(fs.lstat(f.installRoot), { code: 'ENOENT' })
  await fs.rm(path.join(f.dataDir, 'existing-business'))
  management.initializeDesktopManagement(f.dataDir)
  await assert.rejects(installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir }), /桌面管理/)
  await assert.rejects(fs.lstat(f.installRoot), { code: 'ENOENT' })
})


test('a fresh user container is created by the private-directory factory before generic filesystem creation', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3'), original = management.ensurePrivateDataRoot
  let first
  // Capture existence at the synchronous factory boundary without changing ACLs.
  const stat = await import('node:fs')
  t.mock.method(management, 'ensurePrivateDataRoot', directory => {
    if (path.resolve(directory) === path.resolve(f.installRoot) && first === undefined) first = stat.existsSync(directory)
    return original(directory)
  })
  await prepareCliPayload({ sourceRoot, installRoot: f.installRoot })
  assert.equal(first, false)
})


test('old wx locks and unsettled module records block installation without adopting their lifecycle', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  const lockFile = path.join(f.dataDir, 'cli.lock'), oldLock = JSON.stringify({ pid: process.pid, command: 'start' })
  await fs.writeFile(lockFile, oldLock)
  await assert.rejects(installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir }), /旧版操作锁/)
  assert.equal(await fs.readFile(lockFile, 'utf8'), oldLock)
  await assert.rejects(fs.lstat(f.installRoot), { code: 'ENOENT' })
  await fs.rm(lockFile); await fs.mkdir(path.join(f.dataDir, 'module-runtime-registry/records'), { recursive: true })
  await fs.writeFile(path.join(f.dataDir, 'module-runtime-registry/records/unsettled.json'), '{}')
  await assert.rejects(installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir }), /未收口模块/)
  await assert.rejects(fs.lstat(f.installRoot), { code: 'ENOENT' })
})


test('a downloaded version mismatch is refused before creating the installation', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  await assert.rejects(installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir, version: '1.2.4' }), { code: 'CRABOT_CORE_INTEGRITY' })
  await assert.rejects(fs.lstat(f.installRoot), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(f.dataDir), [])
})


test('reinstalling the same CLI repairs only its stopped payload and retains damaged files and user environments', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  const initial = await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })
  const { createInstanceRuntime, clearInstanceRuntime } = await import('../instance-runtime.mjs')
  const record = createInstanceRuntime({ dataDir: f.dataDir, root: initial.coreRoot, mmPort: 19000 })
  clearInstanceRuntime(f.dataDir, record.generation)
  await assert.rejects(fs.lstat(path.join(f.dataDir, 'instance-runtime.json')), { code: 'ENOENT' })
  await fs.mkdir(path.join(f.dataDir, 'agent-venv')); await fs.writeFile(path.join(f.dataDir, 'agent-venv/custom-package'), 'keep dependency')
  await fs.writeFile(path.join(f.installRoot, '.env'), 'keep configuration')
  await fs.writeFile(path.join(initial.coreRoot, 'cli.mjs'), 'damaged payload')
  // Even a self-consistent manifest must belong to this selected directory.
  const changed = await verifyCoreRelease(sourceRoot)
  await fs.rm(path.join(initial.coreRoot, 'core-files.json')); await fs.rm(path.join(initial.coreRoot, 'core-release.json'))
  await writeCoreRelease(initial.coreRoot, changed)
  assert.notEqual((await verifyCoreRelease(initial.coreRoot)).inventory_sha256, initial.id)
  const repaired = await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })
  assert.equal(repaired.id, initial.id)
  assert.equal(readCliSelection(f.installRoot), initial.id)
  assert.equal((await verifyCoreRelease(repaired.coreRoot)).version, '1.2.3')
  assert.equal(await fs.readFile(path.join(repaired.retainedCore, 'cli.mjs'), 'utf8'), 'damaged payload')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'agent-venv/custom-package'), 'utf8'), 'keep dependency')
  assert.equal(await fs.readFile(path.join(f.installRoot, '.env'), 'utf8'), 'keep configuration')
  assert.equal((await promisify(execFile)(repaired.command, ['--version'])).stdout.trim(), '1.2.3')
})

test('repair cannot replace a redirected payload or run while a verified controller is alive', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  const installed = await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })
  const { createInstanceRuntime, clearInstanceRuntime } = await import('../instance-runtime.mjs')
  const record = createInstanceRuntime({ dataDir: f.dataDir, root: installed.coreRoot, mmPort: 19000 })
  await fs.writeFile(path.join(installed.coreRoot, 'cli.mjs'), 'still original damaged file')
  await assert.rejects(installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir }), /实例尚未停止/)
  assert.equal(await fs.readFile(path.join(installed.coreRoot, 'cli.mjs'), 'utf8'), 'still original damaged file')
  clearInstanceRuntime(f.dataDir, record.generation)
  const retained = path.join(f.parent, 'redirected-original')
  await fs.rename(installed.coreRoot, retained)
  await fs.symlink(retained, installed.coreRoot, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir }), { code: 'CRABOT_CLI_INSTALLATION' })
  assert.equal(await fs.readFile(path.join(retained, 'cli.mjs'), 'utf8'), 'still original damaged file')
})


test('a permanent data binding rejects another installation before creating its code', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })
  const before = await fs.readFile(path.join(f.dataDir, 'cli-managed.json'), 'utf8')
  const other = path.join(f.parent, 'other-installation')
  await assert.rejects(installStandaloneCli({ sourceRoot, installRoot: other, dataDir: f.dataDir }), /属于另一 CLI 安装/)
  await assert.rejects(fs.lstat(other), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.dataDir, 'cli-managed.json'), 'utf8'), before)
})

test('repair restores an occupied publication failure and can rebuild a missing selected payload after interruption', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  const installed = await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })
  await fs.writeFile(path.join(installed.coreRoot, 'cli.mjs'), 'retained damage')
  const rename = fs.rename
  const mocked = t.mock.method(fs, 'rename', (from, to) => {
    if (path.basename(from).startsWith('.preparing-') && to === installed.coreRoot) throw Object.assign(new Error('occupied fixture'), { code: 'EBUSY' })
    return rename(from, to)
  })
  await assert.rejects(installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir }), { code: 'EBUSY' })
  mocked.mock.restore()
  assert.equal(await fs.readFile(path.join(installed.coreRoot, 'cli.mjs'), 'utf8'), 'retained damage')
  assert.equal(readCliSelection(f.installRoot), installed.id)
  assert.equal((await fs.readdir(path.dirname(installed.coreRoot))).filter(name => name.startsWith('.preparing-')).length, 0)
  const retained = path.join(path.dirname(installed.coreRoot), '.damaged-interrupted-fixture')
  await fs.rename(installed.coreRoot, retained)
  const repaired = await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })
  assert.equal((await verifyCoreRelease(repaired.coreRoot)).version, '1.2.3')
  assert.equal(await fs.readFile(path.join(retained, 'cli.mjs'), 'utf8'), 'retained damage')
  assert.equal(readCliSelection(f.installRoot), installed.id)
})


for (const dataMode of windows ? [null] : [0o700, 0o755]) test('offline CLI upgrade preserves dependencies and stopped state while verifying a real Node migration; dataMode=' + dataMode, async t => {
  const f = await fixture(t)
  const one = await installStandaloneCli({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot, dataDir: f.dataDir })
  await fs.mkdir(path.join(f.dataDir, 'admin'), { recursive: true })
  await fs.writeFile(path.join(f.dataDir, 'admin/SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(f.dataDir, 'admin/preferences'), 'before')
  for (const directory of ['agent-venv', 'mcp-envs/server', 'workspaces/task']) {
    await fs.mkdir(path.join(f.dataDir, directory), { recursive: true })
    await fs.writeFile(path.join(f.dataDir, directory, 'keep'), 'user dependency')
  }
  const code = "import{writeFileSync}from'node:fs'; const dir=process.argv.find(a=>a.startsWith('--data-dir=')).slice(11); writeFileSync(dir+'/preferences','after');"
  const two = await prepareCliPayload({ sourceRoot: await f.source('1.2.4', {
    'crabot-admin/schema_version': 'v2', 'crabot-admin/upgrade/from_v1_to_v2.mjs': code,
    'crabot-admin/upgrade/scope.mjs': "export const migrationScope = () => ({ reads: [], writes: ['admin/preferences'] })",
  }), installRoot: f.installRoot })
  const unrelated = path.join(f.dataDir, 'agent/traces')
  await fs.mkdir(unrelated, { recursive: true })
  const sparse = await fs.open(path.join(unrelated, 'unrelated-large-history'), 'wx')
  try { await sparse.truncate(windows ? 1024 : 200 * 1024 ** 3) } finally { await sparse.close() }
  const guards = ['readdir', 'lstat', 'open', 'readFile', 'copyFile'].map(method => {
    const original = fs[method]
    return t.mock.method(fs, method, async (...args) => {
      if (typeof args[0] === 'string' && (args[0] === unrelated || args[0].startsWith(unrelated + path.sep))) throw new Error('unrelated history namespace accessed')
      return original(...args)
    })
  })
  if (dataMode !== null) await fs.chmod(f.dataDir, dataMode)
  let result
  try { result = await applyStoppedCliUpgrade({ sourceRoot: one.coreRoot, targetRoot: two.coreRoot, dataDir: f.dataDir }) }
  finally { guards.forEach(guard => guard.mock.restore()) }
  if (dataMode !== null) assert.equal((await fs.stat(f.dataDir)).mode & 0o777, dataMode)
  assert.equal(result.service_started, false); assert.equal(result.health_verified, false)
  assert.equal(inspectInstance(f.dataDir).state, 'stopped')
  assert.equal(readCliSelection(f.installRoot), two.id)
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/SCHEMA_VERSION'), 'utf8'), 'v2\n')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/preferences'), 'utf8'), 'after')
  assert.equal(result.backup, null)
  await assert.rejects(fs.lstat(f.dataDir + '.desktop-backups'), { code: 'ENOENT' })
  const transactionRoot = path.join(f.dataDir, '.upgrade-migrations/crabot-admin-v1-v2')
  const plan = JSON.parse(await fs.readFile(path.join(transactionRoot, 'plan.json'), 'utf8'))
  await verifyBackup(path.join(transactionRoot, 'backup'), plan.description.scope.writes, plan.original)
  assert.deepEqual(plan.description.scope.writes.sort(), [path.join('admin', 'SCHEMA_VERSION'), path.join('admin', 'preferences')].sort())
  assert.equal(await fs.readFile(path.join(transactionRoot, 'backup/admin/preferences'), 'utf8'), 'before')
  for (const directory of ['agent-venv', 'mcp-envs/server', 'workspaces/task']) {
    assert.equal(await fs.readFile(path.join(f.dataDir, directory, 'keep'), 'utf8'), 'user dependency')
  }
  assert.equal((await verifyCoreRelease(one.coreRoot)).version, '1.2.3')
  assert.equal((await promisify(execFile)(one.command, ['--version'], { env: { ...process.env, PATH: '' } })).stdout.trim(), '1.2.4')
})

for (const failure of ['newer-data', 'unsettled-module', 'different-binding', 'changed-target']) {
  test('offline CLI upgrade refuses before switching or fencing: ' + failure, async t => {
    const f = await fixture(t)
    const one = await installStandaloneCli({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot, dataDir: f.dataDir })
    const two = await prepareCliPayload({ sourceRoot: await f.source('1.2.4', { 'crabot-admin/schema_version': 'v1' }), installRoot: f.installRoot })
    if (failure === 'newer-data') {
      await fs.mkdir(path.join(f.dataDir, 'admin'))
      await fs.writeFile(path.join(f.dataDir, 'admin/SCHEMA_VERSION'), 'v2')
      await fs.writeFile(path.join(f.dataDir, 'admin/preferences'), 'keep')
    }
    if (failure === 'unsettled-module') {
      await fs.mkdir(path.join(f.dataDir, 'module-runtime-registry/records'), { recursive: true })
      await fs.writeFile(path.join(f.dataDir, 'module-runtime-registry/records/pending.json'), '{}')
    }
    if (failure === 'different-binding') await fs.rm(path.join(f.dataDir, 'cli-managed.json'))
    if (failure === 'changed-target') await fs.appendFile(path.join(two.coreRoot, 'cli.mjs'), ' ')
    await assert.rejects(applyStoppedCliUpgrade({ sourceRoot: one.coreRoot, targetRoot: two.coreRoot, dataDir: f.dataDir }))
    assert.equal(readCliSelection(f.installRoot), one.id)
    assert.equal(readVersionMaintenance(f.dataDir), null)
    assert.equal(inspectInstance(f.dataDir).state, 'stopped')
  })
}

test('a partially failed migration retains the exact selected target, backup and maintenance fence without replaying', async t => {
  const f = await fixture(t)
  const one = await installStandaloneCli({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot, dataDir: f.dataDir })
  await fs.mkdir(path.join(f.dataDir, 'admin'))
  await fs.writeFile(path.join(f.dataDir, 'admin/SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(f.dataDir, 'admin/preferences'), 'before')
  const code = "import{appendFileSync}from'node:fs'; const dir=process.argv.find(a=>a.startsWith('--data-dir=')).slice(11); appendFileSync(dir+'/preferences',' partial'); process.exit(13);"
  const two = await prepareCliPayload({ sourceRoot: await f.source('1.2.4', {
    'crabot-admin/schema_version': 'v2', 'crabot-admin/upgrade/from_v1_to_v2.mjs': code,
    'crabot-admin/upgrade/scope.mjs': "export const migrationScope = () => ({ reads: [], writes: ['admin/preferences'] })",
  }), installRoot: f.installRoot })
  await assert.rejects(applyStoppedCliUpgrade({ sourceRoot: one.coreRoot, targetRoot: two.coreRoot, dataDir: f.dataDir }), { code: 'CRABOT_MIGRATION_FAILED' })
  const record = readVersionMaintenance(f.dataDir)
  assert.equal(record.phase, 'verifying'); assert.equal(record.target_core.root, two.coreRoot)
  assert.equal(readCliSelection(f.installRoot), two.id)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/SCHEMA_VERSION'), 'utf8'), 'v1')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/preferences'), 'utf8'), 'before')
  const transaction = JSON.parse(await fs.readFile(path.join(f.dataDir, '.upgrade-migrations/crabot-admin-v1-v2/state.json'), 'utf8'))
  assert.equal(transaction.phase, 'rolled_back')
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await assert.rejects(applyStoppedCliUpgrade({ sourceRoot: one.coreRoot, targetRoot: two.coreRoot, dataDir: f.dataDir }))
  assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/preferences'), 'utf8'), 'before')
  assert.equal(record.schema_version, 3); assert.equal(record.backup, null)
  const directory = path.join(f.dataDir, '.upgrade-migrations/crabot-admin-v1-v2')
  const plan = JSON.parse(await fs.readFile(path.join(directory, 'plan.json'), 'utf8'))
  await verifyBackup(path.join(directory, 'backup'), plan.description.scope.writes, plan.original)
  assert.equal(await fs.readFile(path.join(directory, 'backup/admin/preferences'), 'utf8'), 'before')
  await assert.rejects(fs.lstat(f.dataDir + '.desktop-backups'), { code: 'ENOENT' })
})


test('release staging failure cleans only the download and preserves selected code and data', async t => {
  const f = await fixture(t)
  const one = await installStandaloneCli({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot, dataDir: f.dataDir })
  const temporary = path.join(f.parent, 'download'); await fs.mkdir(temporary)
  const tarPath = path.join(temporary, process.platform === 'win32' ? 'release.zip' : 'release.tar.gz')
  await fs.writeFile(tarPath, 'not an archive')
  await assert.rejects(prepareDownloadedCliUpgrade({ root: one.coreRoot, artifact: { tmp: temporary, tarPath, version: 'v1.2.4' } }))
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' })
  assert.equal(readCliSelection(f.installRoot), one.id)
  assert.equal((await verifyCoreRelease(one.coreRoot)).version, '1.2.3')
  assert.equal(readVersionMaintenance(f.dataDir), null)
})

test('release application rejects a valid payload from another container before executing its coordinator', async t => {
  const f = await fixture(t)
  const one = await installStandaloneCli({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot, dataDir: f.dataDir })
  const foreign = await prepareCliPayload({ sourceRoot: await f.source('1.2.4'), installRoot: path.join(f.parent, 'other-installation') })
  await assert.rejects(applyPreparedCliUpgrade({ root: one.coreRoot, dataDir: f.dataDir, prepared: foreign }), /不属于/)
  assert.equal(readCliSelection(f.installRoot), one.id)
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(inspectInstance(f.dataDir).state, 'stopped')
})

test('parallel preparation can copy a read-only Core root and preserves its directory mode', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  let prepared
  await fs.chmod(sourceRoot, 0o555)
  try {
    prepared = await prepareCliPayload({ sourceRoot, installRoot: f.installRoot })
    assert.equal((await fs.stat(prepared.coreRoot)).mode & 0o777, 0o555)
    assert.equal((await verifyCoreRelease(prepared.coreRoot)).version, '1.2.3')
  } finally {
    await fs.chmod(sourceRoot, 0o755)
    if (prepared) await fs.chmod(prepared.coreRoot, 0o755)
  }
})

test('failed preparation cleanup preserves the original error and always releases the installation lock', async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  const copy = fs.cp, remove = fs.rm
  const primary = Object.assign(new Error('copy failed'), { code: 'EIO' })
  const cleanup = Object.assign(new Error('cleanup failed'), { code: 'EACCES' })
  fs.cp = async () => { throw primary }
  fs.rm = async (file, options) => {
    if (path.basename(String(file)).startsWith('.preparing-')) throw cleanup
    return remove(file, options)
  }
  try {
    await assert.rejects(prepareCliPayload({ sourceRoot, installRoot: f.installRoot }), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.cause, primary)
      assert.deepEqual(error.errors, [primary, cleanup])
      return true
    })
  } finally { fs.cp = copy; fs.rm = remove }
  const lock = await acquireCliLock(f.installRoot, 'after-failed-cleanup', 0)
  releaseCliLock(lock)
  assert.equal(readCliSelection(f.installRoot), null)
  assert.equal((await verifyCoreRelease(sourceRoot)).version, '1.2.3')
})

test('a data migration cannot follow an external module directory that the scoped backup does not contain', async t => {
  const f = await fixture(t)
  const one = await installStandaloneCli({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot, dataDir: f.dataDir })
  const external = path.join(f.parent, 'external-data'); await fs.mkdir(external)
  await fs.writeFile(path.join(external, 'SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(external, 'preferences'), 'external-before')
  await fs.symlink(external, path.join(f.dataDir, 'admin'), process.platform === 'win32' ? 'junction' : 'dir')
  const code = "import{writeFileSync}from'node:fs'; const dir=process.argv.find(a=>a.startsWith('--data-dir=')).slice(11); writeFileSync(dir+'/preferences','external-after');"
  const two = await prepareCliPayload({ sourceRoot: await f.source('1.2.4', {
    'crabot-admin/schema_version': 'v2', 'crabot-admin/upgrade/from_v1_to_v2.mjs': code,
    'crabot-admin/upgrade/scope.mjs': "export const migrationScope = () => ({ reads: [], writes: ['admin/preferences'] })",
  }), installRoot: f.installRoot })
  await assert.rejects(applyStoppedCliUpgrade({ sourceRoot: one.coreRoot, targetRoot: two.coreRoot, dataDir: f.dataDir }), { code: 'CRABOT_BACKUP_SCOPE_UNVERIFIED' })
  assert.equal(readCliSelection(f.installRoot), one.id)
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fs.readFile(path.join(external, 'preferences'), 'utf8'), 'external-before')
  assert.equal(await fs.readFile(path.join(external, 'SCHEMA_VERSION'), 'utf8'), 'v1')
})

test('user read-only Core publication retains writable private staging until rename', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3'), rename = fs.rename
  await fs.chmod(sourceRoot, 0o555)
  let prepared, checked = false
  const patch = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(String(from)).startsWith('.preparing-')) {
      checked = true
      const mode = (await fs.stat(from)).mode & 0o777
      if (mode !== 0o700) throw Object.assign(new Error('controlled readonly directory rename refusal'), { code: 'EACCES' })
    }
    return rename(from, to)
  })
  try {
    prepared = await prepareCliPayload({ sourceRoot, installRoot: f.installRoot })
    assert.equal(checked, true); assert.equal((await fs.stat(prepared.coreRoot)).mode & 0o777, 0o555)
  } finally {
    patch.mock.restore(); await fs.chmod(sourceRoot, 0o755)
    if (prepared) await fs.chmod(prepared.coreRoot, 0o755)
    // A failing old implementation may leave this fixture's readonly staging.
    const releases = path.join(f.installRoot, 'releases')
    for (const name of await fs.readdir(releases).catch(() => [])) if (name.startsWith('.preparing-')) await fs.chmod(path.join(releases, name), 0o700)
  }
})


test('code-only CLI replacement creates no outer data backup and keeps the service stopped', async t => {
  const f = await fixture(t)
  const one = await installStandaloneCli({ sourceRoot: await f.source('1.2.3'), installRoot: f.installRoot, dataDir: f.dataDir })
  const two = await prepareCliPayload({ sourceRoot: await f.source('1.2.4'), installRoot: f.installRoot })
  await fs.mkdir(path.join(f.dataDir, 'agent/traces'), { recursive: true })
  await fs.writeFile(path.join(f.dataDir, 'agent/traces/keep'), 'untouched history')
  const result = await applyStoppedCliUpgrade({ sourceRoot: one.coreRoot, targetRoot: two.coreRoot, dataDir: f.dataDir })
  assert.equal(result.backup, null); assert.equal(result.service_started, false)
  assert.equal(readCliSelection(f.installRoot), two.id)
  assert.equal(readVersionMaintenance(f.dataDir), null)
  for (const directory of [f.dataDir + '.desktop-backups', path.join(f.dataDir, '.upgrade-migrations')]) await assert.rejects(fs.lstat(directory), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.dataDir, 'agent/traces/keep'), 'utf8'), 'untouched history')
})

for (const [rootMode, dataMode] of [[0o700, 0o755], [0o755, 0o700], [0o755, 0o755]]) test('same-version CLI reinstall retains existing bound permissions: ' + rootMode + '/' + dataMode, { skip: windows }, async t => {
  const f = await fixture(t), sourceRoot = await f.source('1.2.3')
  const first = await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })
  await fs.writeFile(path.join(f.dataDir, 'keep-user-data'), 'preserved')
  await fs.chmod(f.installRoot, rootMode); await fs.chmod(f.dataDir, dataMode)
  const second = await installStandaloneCli({ sourceRoot, installRoot: f.installRoot, dataDir: f.dataDir })
  assert.equal(second.id, first.id)
  assert.equal((await fs.stat(f.installRoot)).mode & 0o777, rootMode)
  assert.equal((await fs.stat(f.dataDir)).mode & 0o777, dataMode)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'keep-user-data'), 'utf8'), 'preserved')
  assert.equal(inspectInstance(f.dataDir).state, 'stopped')
})
