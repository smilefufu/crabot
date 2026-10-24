import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readUbuntuBootstrap } from '../../scripts/desktop/package-ubuntu-installer.mjs'
import { runBounded } from '../../scripts/lib/run-bounded.mjs'
const project = await fs.realpath(path.resolve(process.argv[2])), info = JSON.parse(await fs.readFile(path.join(project, 'installer-location.json'), 'utf8'))
assert.equal(info.schema_version, 1); assert.equal(info.candidate_only, true)
function within(relative) {
  assert.equal(typeof relative, 'string'); assert.equal(path.isAbsolute(relative), false)
  const result = path.resolve(project, relative), difference = path.relative(project, result)
  assert.ok(difference && difference !== '..' && !difference.startsWith('..' + path.sep) && !path.isAbsolute(difference)); return result
}
const executable = within(info.executable), payload = within(info.payload), resources = path.dirname(payload)
const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot installer host ')))
try {
  if (info.bootstrap === 'gtk4') {
    assert.equal(process.platform, 'linux')
    const release = JSON.parse(await fs.readFile(path.join(payload, 'core/core-release.json'), 'utf8'))
    await readUbuntuBootstrap(resources, release.commit)
    await fs.cp(path.join(resources, 'backend'), path.join(root, 'backend'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    await fs.cp(path.join(resources, 'crabot-client'), path.join(root, 'crabot-client'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    // Only the backend is relocated. The opaque payload is read-only and is not
    // another multi-GB copy; no install action or OS authorization runs here.
    await fs.symlink(payload, path.join(root, 'offline'), 'dir')
    const env = { ...process.env }
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'LD_PRELOAD', 'LD_LIBRARY_PATH']) delete env[name]
    const { stdout } = await promisify(execFile)(path.join(payload, 'core/.product-runtime/node/bin/node'),
      [path.join(root, 'backend/dist/ubuntu-installer-backend.js'), '--verify-payload-only'], { env, timeout: 180_000, maxBuffer: 65536 })
    assert.deepEqual(JSON.parse(stdout.trim()), { type: 'payload_verified', business_mm_started: false })
    const repair = path.join(root, 'backend/dist/bootstrap/scripts/lib/desktop-repair.mjs')
    const code = `
      import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url';
      const load = index => import(pathToFileURL(process.argv[index]).href);
      const repair = await load(1), reader = await load(2), proof = await load(3);
      const controller = await load(4), host = await load(5);
      assert.equal(typeof repair.prepareDesktopRepair, 'function'); assert.equal(typeof repair.commitDesktopRepair, 'function');
      assert.equal(typeof reader.default.readDesktopRemoval, 'function');
      assert.equal(typeof proof.captureDesktopRemovalProof, 'function'); assert.equal(typeof proof.readDesktopRemovalProof, 'function');
      assert.equal(typeof controller.stopInstance, 'function'); assert.equal(typeof host.prepareDesktopRemovalGui, 'function');
    `
    await promisify(execFile)(path.join(payload, 'core/.product-runtime/node/bin/node'), ['--input-type=module', '-e', code, repair, path.join(root, 'backend/dist/bootstrap/scripts/lib/desktop-removal-record.cjs'), path.join(root, 'backend/dist/bootstrap/scripts/lib/desktop-removal-proof.mjs'),
      path.join(root, 'backend/dist/bootstrap/scripts/lib/instance-controller.mjs'), path.join(root, 'backend/dist/bootstrap/scripts/lib/desktop-removal-host.mjs')],
      { env, timeout: 30_000, maxBuffer: 65536 })
    console.log('CRABOT_INSTALLER_HOST ' + JSON.stringify({ native_source_and_bytes: true, opaque_payload_verified: true,
      ordinary_uid_backend_outside_checkout: true, trusted_repair_backend_outside_checkout: true, trusted_removal_reader_outside_checkout: true, trusted_removal_proof_outside_checkout: true, trusted_common_stop_outside_checkout: true, trusted_removal_host_backend_outside_checkout: true, actual_installer_flow: false, graphical_polkit: false, real_browser_sandbox: false, business_mm_started: false }))
  } else {
  await fs.mkdir(path.join(root, 'resources'))
  for (const name of ['app.asar', 'app.asar.unpacked']) await fs.cp(path.join(resources, name), path.join(root, 'resources', name), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  const require = createRequire(new URL('../../crabot-desktop/package.json', import.meta.url)), builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
  const { getCurrentFuseWire, FuseV1Options } = builder('@electron/fuses'), fuses = await getCurrentFuseWire(executable)
  for (const key of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments]) assert.equal(fuses[key], 48)
  assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], 49)
  const env = { ...process.env, CRABOT_INSTALLER_PROBE_ROOT: root, CRABOT_INSTALLER_PROBE_PAYLOAD: payload }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'NODE_OPTIONS', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[key]
  await runBounded(require('electron'), [fileURLToPath(new URL('../../crabot-desktop/tests/installer-host-probe.cjs', import.meta.url))], { env, timeout: 180_000 })
  const report = JSON.parse(await fs.readFile(path.join(root, 'probe-report.json'), 'utf8'))
  for (const key of ['trusted_backend_in_asar', 'trusted_repair_backend_in_asar', 'trusted_removal_reader_in_asar', 'trusted_removal_proof_in_asar', 'trusted_removal_host_backend_in_asar', 'trusted_common_stop_in_asar', 'opaque_payload_verified', 'sandboxed_progress_preload', 'sandboxed_removal_progress_preload', 'outside_checkout']) assert.equal(report[key], true)
  assert.equal(report.actual_installer_flow, false); assert.equal(report.business_mm_started, false)
  }
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
