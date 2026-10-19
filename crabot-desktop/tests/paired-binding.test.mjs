import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import identity from '../../scripts/lib/process-identity.cjs'
import management from '../../scripts/lib/desktop-management.cjs'
import { writeCoreRelease } from '../../scripts/lib/core-release.mjs'

for (const scenario of ['pin-mismatch', 'core-corrupt', 'detached-pair']) test('actual GUI entry refuses external Core execution before initialization: ' + scenario, { timeout: 35_000 }, async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-gui-binding-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = management.ensurePrivateDataRoot(path.join(parent, 'install')), profile = management.ensurePrivateDataRoot(path.join(parent, 'profile'))
  for (const name of ['app/releases', 'releases', 'bin']) await fs.mkdir(path.join(root, name), { recursive: true })
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), marker = path.join(parent, 'external-core-executed')
  const stage = path.join(root, 'releases/stage'); await fs.mkdir(path.join(stage, 'scripts/lib'), { recursive: true })
  for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(stage, file), JSON.stringify({ version: '1.2.3' }))
  const instance = path.join(stage, 'scripts/lib/instance.mjs')
  await fs.writeFile(instance, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'external code executed');export const resolveCliDataDir=()=>${JSON.stringify(data)};`)
  await writeCoreRelease(stage, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: 'a'.repeat(40), source_dirty: false })
  const release = JSON.parse(await fs.readFile(path.join(stage, 'core-release.json'), 'utf8'))
  const selection = { schema_version: 1, version: release.version, gui_id: randomUUID(), core_id: release.inventory_sha256 }
  const core = path.join(root, 'releases', selection.core_id); await fs.rename(stage, core)
  const gui = path.join(root, 'app/releases', selection.gui_id)
  let resources = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
  const executable = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
  await fs.mkdir(resources, { recursive: true }); await fs.mkdir(path.dirname(executable), { recursive: true })
  await fs.writeFile(executable, 'fixture executable; never started')
  await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(selection))
  const stat = await fs.stat(root, { bigint: true })
  const record = { schema_version: 1, installation_id: randomUUID(), owner: identity.inspectProcess(process.pid).owner,
    install_root: root, root_identity: { dev: String(stat.dev), ino: String(stat.ino) }, paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } }
  for (const [file, value] of [['desktop-installation.json', record], ['current-release.json', selection]]) {
    if (process.platform === 'win32') identity.writePrivateFile(path.join(root, file), JSON.stringify(value) + '\n')
    else await fs.writeFile(path.join(root, file), JSON.stringify(value) + '\n', { mode: 0o600 })
  }
  if (scenario === 'core-corrupt') await fs.appendFile(path.join(core, 'scripts/lib/instance.mjs'), '\n// changed after sealing')
  if (scenario === 'detached-pair') {
    const moved = path.join(parent, 'detached/app/releases', selection.gui_id)
    await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(gui, moved)
    resources = path.join(moved, path.relative(gui, resources))
    await fs.rm(path.join(resources, 'desktop-release.json'))
    await fs.rename(core, path.join(resources, 'core'))
  }
  const options = path.join(parent, 'fixture.json'), report = path.join(parent, 'report.json')
  await fs.writeFile(options, JSON.stringify({ resources, profile, data, marker, report,
    pin: scenario === 'pin-mismatch' ? { ...selection, gui_id: randomUUID() } : selection }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./paired-binding-rejection.cjs', import.meta.url)), options],
      { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 25_000 })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
  })
  assert.equal(result.code, 0, result.output)
  const evidence = JSON.parse(await fs.readFile(report, 'utf8'))
  assert.deepEqual(evidence, { external_core_executed: false, repair_shown: true, data_entries: [], business_mm_started: false, actual_packaged_binary: false })
  console.log('CRABOT_GUI_BINDING_REJECTION ' + JSON.stringify({ scenario, ...evidence }))
})
