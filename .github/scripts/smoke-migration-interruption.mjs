// Regression with a controlled payload: actual upgrade/backup/recovery layers,
// one disposable migration child, no business MM, provider or production data.
import assert from 'node:assert/strict'
import { promises as fs, constants, realpathSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const checkout = new URL('../../', import.meta.url)
const load = file => import(new URL(file, checkout).href)
const { writeCoreRelease } = await load('scripts/lib/core-release.mjs')
const { installStandaloneCli } = await load('scripts/lib/standalone-cli-install.mjs')
const { prepareCliPayload, readCliSelection } = await load('scripts/lib/cli-installation.mjs')
const { acquireCliLock, releaseCliLock } = await load('scripts/lib/cli-lock.mjs')
const { assertVersionMaintenanceAllowsStart, readVersionMaintenance } = await load('scripts/lib/version-maintenance.mjs')
const { verifyMaintenanceBackup } = await load('scripts/lib/maintenance-backup.mjs')
const { default: identity } = await load('scripts/lib/process-identity.cjs')
const { default: management } = await load('scripts/lib/desktop-management.cjs')
const { DesktopController } = await load('crabot-desktop/dist/controller.js')
const parentDir = realpathSync(await fs.mkdtemp(path.join(tmpdir(), 'Crabot schema fence ')))
const data = management.ensurePrivateDataRoot(path.join(parentDir, 'data')), installation = path.join(parentDir, 'installation')
const windows = process.platform === 'win32', binaryName = windows ? 'crabot.exe' : 'crabot'
const nativeCommand = fileURLToPath(new URL('crabot-native/build/Release/' + binaryName, checkout))
const nodeHash = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
async function source(version, additions = {}) {
  const root = path.join(parentDir, 'core-' + version), relative = windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node'
  const node = path.join(root, relative), bin = path.posix.dirname(relative)
  await fs.mkdir(path.dirname(node), { recursive: true }); await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE)
  await fs.mkdir(path.join(root, 'bin')); await fs.copyFile(nativeCommand, path.join(root, 'bin', binaryName))
  if (!windows) { await fs.chmod(node, 0o755); await fs.chmod(path.join(root, 'bin', binaryName), 0o755) }
  await fs.writeFile(path.join(root, 'cli.mjs'), 'console.log(' + JSON.stringify(version) + ')')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version }))
  // This controlled payload executes only a Node migration; other slots are not run.
  await fs.writeFile(path.join(root, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version, platform: process.platform, arch: process.arch,
    versions: { node: process.versions.node, python: '3.12.12' }, executables: Object.fromEntries(['node', 'python', 'uv', 'bash', 'git', 'rg'].map(name => [name, relative])),
    path_entries: [bin], python_home: bin, memory_packages: bin, seed_wheels: [], files: { [relative]: { size: (await fs.stat(node)).size, sha256: nodeHash } } }))
  for (const [file, text] of Object.entries(additions)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text) }
  await writeCoreRelease(root, { schema_version: 1, version, platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  return root
}
let parent, childIdentity, controller
try {
  const old = await installStandaloneCli({ sourceRoot: await source('1.2.3'), installRoot: installation, dataDir: data })
  const admin = path.join(data, 'admin'); await fs.mkdir(admin); await fs.writeFile(path.join(admin, 'SCHEMA_VERSION'), 'v1'); await fs.writeFile(path.join(admin, 'preferences'), 'before')
  const migration = `import{existsSync,writeFileSync,appendFileSync}from'node:fs';const data=process.argv.find(a=>a.startsWith('--data-dir=')).slice(11);appendFileSync(data+'/invocations','one\\n');writeFileSync(data+'/child-pid',String(process.pid));const deadline=setTimeout(()=>clearInterval(gate),30000);const gate=setInterval(()=>{if(existsSync(data+'/finish')){clearInterval(gate);clearTimeout(deadline);writeFileSync(data+'/preferences','changed-once')}},20)`
  const target = await prepareCliPayload({ sourceRoot: await source('1.2.4', { 'crabot-admin/schema_version': 'v2', 'crabot-admin/upgrade/from_v1_to_v2.mjs': migration }), installRoot: installation })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key)))
  const parentCode = `
    import path from 'node:path';
    import {keepControlledChildAfterParentExit} from ${JSON.stringify(new URL('scripts/lib/__tests__/fixtures/controlled-orphan.mjs', checkout).href)};
    import {applyStoppedCliUpgrade} from ${JSON.stringify(new URL('scripts/lib/standalone-cli-upgrade.mjs', checkout).href)};
    const [sourceRoot,targetRoot,dataDir] = process.argv.slice(1);
    keepControlledChildAfterParentExit(path.join(targetRoot,'crabot-admin/upgrade/from_v1_to_v2.mjs'));
    await applyStoppedCliUpgrade({sourceRoot,targetRoot,dataDir,env:process.env});
  `
  parent = spawn(process.execPath, ['--input-type=module', '-e', parentCode, old.coreRoot, target.coreRoot, data], { env, stdio: ['ignore', 'ignore', 'inherit'] })
  const deadline = Date.now() + 30000
  while (!(await fs.stat(path.join(admin, 'child-pid')).catch(() => null))) { assert.ok(Date.now() < deadline && parent.exitCode === null, 'controlled migration did not start'); await new Promise(resolve => setTimeout(resolve, 20)) }
  childIdentity = identity.inspectProcess(Number(await fs.readFile(path.join(admin, 'child-pid'), 'utf8')))
  assert.equal(readVersionMaintenance(data).phase, 'verifying')
  const parentExit = once(parent, 'exit'); parent.kill('SIGKILL'); await parentExit
  assert.ok(identity.sameProcess(childIdentity, identity.inspectProcess(childIdentity.pid)), 'The controlled migration must still be active')
  assert.equal(readCliSelection(installation), target.id)
  const lock = await acquireCliLock(data, 'next-start', 0)
  try { assert.throws(() => assertVersionMaintenanceAllowsStart(data), { code: 'CRABOT_MAINTENANCE_PENDING' }) }
  finally { releaseCliLock(lock) }
  controller = new DesktopController({ coreRoot: target.coreRoot, dataRoot: data, appVersion: '1.2.4', platform: process.platform })
  controller.load = file => load(file)
  let starts = 0
  controller.startCore = async () => { starts++; throw new Error('Must not start before unknown migration is resolved') }
  await assert.rejects(controller.recoverVersion(), { code: 'CRABOT_MIGRATION_INTERRUPTED' })
  assert.equal(starts, 0)
  await fs.writeFile(path.join(admin, 'finish'), 'finish-this-one-controlled-script')
  const childDeadline = Date.now() + 30000
  while (identity.sameProcess(childIdentity, identity.inspectProcess(childIdentity.pid))) {
    assert.ok(Date.now() < childDeadline, 'The controlled migration did not settle')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await assert.rejects(controller.recoverVersion(), { code: 'CRABOT_MIGRATION_INTERRUPTED' })
  assert.equal(starts, 0)
  assert.equal(await fs.readFile(path.join(admin, 'SCHEMA_VERSION'), 'utf8'), 'v1')
  assert.equal(await fs.readFile(path.join(admin, 'preferences'), 'utf8'), 'changed-once')
  assert.equal((await fs.readFile(path.join(admin, 'invocations'), 'utf8')).trim(), 'one')
  const maintenance = readVersionMaintenance(data)
  assert.equal(maintenance.phase, 'verifying')
  const backupRoot = path.join(data + '.desktop-backups', maintenance.backup.id)
  const backup = await verifyMaintenanceBackup(backupRoot, maintenance.backup.sha256)
  assert.equal(backup.source, data)
  assert.equal(await fs.readFile(path.join(backupRoot, 'data/admin/SCHEMA_VERSION'), 'utf8'), 'v1')
  assert.equal(await fs.readFile(path.join(backupRoot, 'data/admin/preferences'), 'utf8'), 'before')
  console.log('CRABOT_SCHEMA_FENCE ' + JSON.stringify({ platform: process.platform, controlled_payload: true, orphan_fault_injected: windows, parent_crash: true, active_child_start_blocked: true,
    gui_recovery_replay_blocked_before_and_after_exit: true, script_invocations: 1, schema_marker_unchanged: true, backup_retained: true, business_mm_started: false }))
} finally {
  controller?.close()
  if (parent && parent.exitCode === null && parent.signalCode === null) { const ended = once(parent, 'exit'); parent.kill('SIGKILL'); await ended }
  if (childIdentity && identity.sameProcess(childIdentity, identity.inspectProcess(childIdentity.pid))) process.kill(childIdentity.pid, 'SIGKILL')
  await fs.rm(parentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
