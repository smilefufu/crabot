import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
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
  for (const key of ['trusted_backend_in_asar', 'opaque_payload_verified', 'sandboxed_progress_preload', 'outside_checkout']) assert.equal(report[key], true)
  assert.equal(report.actual_installer_flow, false); assert.equal(report.business_mm_started, false)
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
