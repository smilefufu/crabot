// Real bundled interpreter + offline wheel + scoped maintenance/reference I/O.
// Covers the original system metadata fixture and a real fenced legacy-user
// source. This never starts MM or claims whole-installation conversion.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyCoreRelease } from '../../scripts/lib/core-release.mjs'
import { acquireCliLock, releaseCliLock } from '../../scripts/lib/cli-lock.mjs'
import { createMaintenanceBackup } from '../../scripts/lib/maintenance-backup.mjs'
import { inspectLegacyPythonEnvironment } from '../../scripts/lib/legacy-python.mjs'
import { prepareLegacyPythonRebuild } from '../../scripts/lib/legacy-python-rebuild.mjs'
import { materializeLegacyRelease } from '../../scripts/lib/__tests__/fixtures/legacy-release.mjs'
import { discoverLegacyUserInstall } from '../../scripts/lib/legacy-desktop.mjs'
import { fenceLegacyEntries } from '../../scripts/lib/legacy-entry-fence.mjs'
import { readVersionMaintenance, recordVersionMaintenanceBackup, assertVersionMaintenanceAllowsStart,
  beginLegacyUserVersionMaintenance, prepareScopedVersionMaintenance, markVersionMaintenanceInstalling,
  bindLegacyPythonMaintenance, selectLegacyPythonMaintenance } from '../../scripts/lib/version-maintenance.mjs'
import management from '../../scripts/lib/desktop-management.cjs'
import identity from '../../scripts/lib/process-identity.cjs'
import product from '../../scripts/lib/product-runtime.cjs'
import selection from '../../scripts/lib/agent-python-selection.cjs'
const require = createRequire(new URL('../../crabot-admin/package.json', import.meta.url)), AdmZip = require('adm-zip')
const execute = promisify(execFile), root = await fs.realpath(process.argv[2]), core = await verifyCoreRelease(root)
const runtime = product.loadProductRuntime(root, { required: true, full: true })
for (const file of ['scripts/lib/version-maintenance.mjs', 'scripts/lib/legacy-python-rebuild.mjs', 'scripts/lib/legacy-python-selection.mjs', 'scripts/desktop/inspect-legacy-python.py']) {
  assert.deepEqual(await fs.readFile(path.join(root, file)), await fs.readFile(new URL('../../' + file, import.meta.url)),
    'This component probe requires a Core staged from the current tested sources: ' + file)
}
async function verifySource(sourceKind) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot Python transaction ')))
  let lock
  try {
    const legacyRoot = path.join(parent, 'source')
    const dataDir = management.ensurePrivateDataRoot(path.join(sourceKind === 'legacy-user' ? legacyRoot : parent, 'data')), old = path.join(dataDir, 'agent-venv')
    const site = path.join(old, process.platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.11/site-packages')
    const info = 'crabot_transaction_probe-1.2.3.dist-info/', metadata = 'Metadata-Version: 2.1\nName: crabot-transaction-probe\nVersion: 1.2.3\n'
    const digest = bytes => createHash('sha256').update(bytes).digest('base64url')
    const records = files => Object.entries(files).map(([name, bytes]) => `${name},sha256=${digest(bytes)},${Buffer.byteLength(bytes)}`).join('\n') + '\n' + info + 'RECORD,,\n'
    const oldFiles = { 'crabot_transaction_probe.py': 'raise RuntimeError("OLD_CODE_MUST_NOT_EXECUTE")\n', [info + 'METADATA']: metadata }
    await fs.mkdir(path.join(site, info), { recursive: true }); await fs.writeFile(path.join(old, 'pyvenv.cfg'), 'version_info = 3.11.14\n')
    for (const [name, bytes] of Object.entries(oldFiles)) await fs.writeFile(path.join(site, name), bytes)
    await fs.writeFile(path.join(site, info, 'RECORD'), records(oldFiles))
    const wheels = path.join(parent, 'wheels'); await fs.mkdir(wheels)
    const archive = new AdmZip(), files = { 'crabot_transaction_probe.py': 'value="verified-new-environment"\n', [info + 'METADATA']: metadata,
      [info + 'WHEEL']: 'Wheel-Version: 1.0\nGenerator: crabot-transaction-regression\nRoot-Is-Purelib: true\nTag: py3-none-any\n' }
    for (const [name, bytes] of Object.entries(files)) archive.addFile(name, Buffer.from(bytes))
    archive.addFile(info + 'RECORD', Buffer.from(records(files))); archive.writeZip(path.join(wheels, 'crabot_transaction_probe-1.2.3-py3-none-any.whl'))
    await fs.mkdir(path.join(dataDir, 'fixture')); await fs.writeFile(path.join(dataDir, 'fixture/config'), 'retained fixture data')
    const original = await inspectLegacyPythonEnvironment({ root, dataDir }), operation = randomUUID()
    let id = randomUUID(), backup
    const record = { schema_version: 2, id, data_dir: dataDir, install_root: path.join(parent, 'retained-source-policy-fixture'),
      source_version: 'v2026.10.15.1', target_version: core.version, system_operation_id: operation,
      legacy_source: { scope: 'system', entry_fence_id: randomUUID(), fingerprint: 'a'.repeat(64), manifest_fingerprint: 'b'.repeat(64) },
      target_core: { root, inventory_sha256: core.inventory_sha256 }, phase: 'preparing', backup: null }
    const journal = path.join(dataDir, 'desktop-maintenance.json')
    const write = async value => {
      const bytes = JSON.stringify(value) + '\n'
      if (process.platform === 'win32' && !await fs.stat(journal).catch(() => null)) identity.writePrivateFile(journal, bytes)
      else await fs.writeFile(journal, bytes, { mode: 0o600, flush: true })
    }
    lock = await acquireCliLock(dataDir, 'offline-python-maintenance-smoke')
    if (sourceKind === 'legacy-user') {
      await materializeLegacyRelease(legacyRoot)
      const installation = await discoverLegacyUserInstall({ root: legacyRoot, dataDir }), entry = await fenceLegacyEntries(installation)
      const scoped = await beginLegacyUserVersionMaintenance({ dataDir, installation, entryFenceId: entry.id, targetRoot: root, dataProtection: 'scoped' })
      id = scoped.id
      await prepareScopedVersionMaintenance(dataDir, id)
      await assert.rejects(fs.stat(dataDir + '.desktop-backups'), { code: 'ENOENT' })
    } else {
      await write(record)
      backup = await createMaintenanceBackup(dataDir); await recordVersionMaintenanceBackup(dataDir, id, backup)
    }
    const offline = (command, args, options) => execute(command,
      command === runtime.executables.uv && args[1] === 'install' ? [...args, '--offline', '--no-index', '--find-links', wheels] : args, options)
    const prepared = await prepareLegacyPythonRebuild({ root, dataDir, expectedFingerprint: original.fingerprint, execute: offline })
    const bound = await bindLegacyPythonMaintenance({ dataDir, id, prepared })
    assert.equal(selection.readAgentEnvironmentReference(dataDir), null)
    await assert.rejects(selectLegacyPythonMaintenance({ dataDir, id }), { code: 'CRABOT_MAINTENANCE_PENDING' })
    if (sourceKind === 'legacy-user') await markVersionMaintenanceInstalling(dataDir, id)
    else {
      // This component test does not execute or impersonate the root sealing role.
      await write({ ...bound, phase: 'installing' })
    }
    const selected = await selectLegacyPythonMaintenance({ dataDir, id })
    assert.equal(selected.selected, true); assert.equal(selection.readAgentEnvironmentSelection(dataDir).record.id, prepared.id)
    const result = await execute(prepared.binary, ['-I', '-B', '-X', 'utf8', '-c', 'import crabot_transaction_probe;print(crabot_transaction_probe.value)'],
      { env: product.productEnvironment(runtime, dataDir, {}), timeout: 15000 })
    assert.equal(result.stdout.trim(), 'verified-new-environment')
    assert.equal((await inspectLegacyPythonEnvironment({ root, dataDir })).fingerprint, original.fingerprint)
    assert.equal(await fs.readFile(path.join(site, 'crabot_transaction_probe.py'), 'utf8'), oldFiles['crabot_transaction_probe.py'])
    if (backup) assert.equal(await fs.readFile(path.join(backup.directory, 'data/fixture/config'), 'utf8'), 'retained fixture data')
    else {
      assert.equal(await fs.readFile(path.join(dataDir, 'fixture/config'), 'utf8'), 'retained fixture data')
      await assert.rejects(fs.stat(dataDir + '.desktop-backups'), { code: 'ENOENT' })
    }
    assert.equal(readVersionMaintenance(dataDir).phase, 'installing'); assert.throws(() => assertVersionMaintenanceAllowsStart(dataDir))
    console.log('CRABOT_PYTHON_MAINTENANCE ' + JSON.stringify({ platform: process.platform, arch: process.arch, actual_bundled_python: true,
      actual_offline_wheel: true, actual_durable_default: true, no_early_selection: true, original_environment_preserved: true,
      scoped_backup_verified: Boolean(backup), no_wide_backup: !backup, source_kind: sourceKind, business_start_still_fenced: true, source_policy_fixture: sourceKind === 'system', root_conversion_verified: false, mm_started: false }))
  } finally { releaseCliLock(lock); await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }

}
for (const sourceKind of ['system', 'legacy-user']) await verifySource(sourceKind)
