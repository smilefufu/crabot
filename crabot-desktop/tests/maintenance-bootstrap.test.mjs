import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const desktop = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(new URL('../package.json', import.meta.url))
test('the GUI ships its exact fixed maintenance bootstrap and loads it independently without Core', { timeout: 90000 }, async t => {
  const { desktopMaintenanceBootstrap } = await import('../../scripts/lib/desktop-maintenance-bootstrap.mjs')
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-fixed-gui-bootstrap-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const generated = path.join(desktop, 'dist/bootstrap')
  await fs.mkdir(generated, { recursive: true }); await fs.writeFile(path.join(generated, 'stale-fixture.txt'), 'not part of this build')
  await promisify(execFile)(process.execPath, ['build-preload.mjs'], { cwd: desktop, timeout: 30000, maxBuffer: 65536 })
  const files = []
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(directory, entry.name))
      else files.push(path.relative(generated, path.join(directory, entry.name)).split(path.sep).join('/'))
    }
  }
  await walk(generated)
  assert.deepEqual(files.sort(), [...desktopMaintenanceBootstrap, 'scripts/desktop/extract-paired-release.py', 'crabot-native/build/Release/crabot-native.node'].sort())
  const source = path.join(root, 'source'), bootstrap = path.join(source, 'dist/bootstrap')
  await fs.mkdir(source); await fs.cp(generated, bootstrap, { recursive: true })
  await fs.writeFile(path.join(source, 'package.json'), '{"type":"module"}')
  const parser = path.join(source, 'node_modules/@electron/asar')
  await fs.mkdir(parser, { recursive: true })
  await require('esbuild').build({ entryPoints: [require.resolve('@electron/asar')], outfile: path.join(parser, 'index.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['original-fs'], logLevel: 'silent' })
  await fs.writeFile(path.join(parser, 'package.json'), '{"name":"@electron/asar","main":"index.cjs"}')
  const asar = require('@electron/asar'); await asar.createPackageWithOptions(source, path.join(root, 'app.asar'), { unpack: '**/*.node' })
  const env = { ...process.env, CRABOT_MAINTENANCE_PROBE_ROOT: root }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'NODE_OPTIONS', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[key]
  await promisify(execFile)(require('electron'), [fileURLToPath(new URL('maintenance-bootstrap-probe.cjs', import.meta.url))], { cwd: root, env, timeout: 60000, maxBuffer: 65536 })
  const report = JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8'))
  assert.deepEqual(report, { fixed_gui_bootstrap_loaded: true, initial_frame_loaded: true, initial_job_loaded: true, native_helper_loaded: true, core_present: false, business_mm_started: false,
    stop_called: false, host_executed: false, removal_published: false })
})
