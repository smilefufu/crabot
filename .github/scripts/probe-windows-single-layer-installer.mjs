// Tiny actual product NSIS/decoder fixture. It contains inert program bytes;
// silent execution never launches a GUI, Core, legacy service or model call.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { packageWindowsInstaller } from '../../scripts/desktop/package-windows-installer.mjs'
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const root = await fs.mkdtemp(path.join(tmpdir(), 'Crabot decoder proof ')), execute = promisify(execFile)
const source = path.join(root, 'source'), output = path.join(root, 'output'), directory = path.join(source, 'offline')
const coreRoot = path.join(directory, 'core'), guiRoot = path.join(directory, 'gui')
const selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: 'a'.repeat(64) }
const relative = '.scrapling-runtime-desktop-ci-b21869a0a229da99-8413626c/packages/playwright/driver/package/lib/tools/skills/playwright-component-testing/references/gallery-spec.md'
try {
  await fs.mkdir(path.join(source, 'app'), { recursive: true }); await fs.mkdir(output)
  await fs.writeFile(path.join(source, 'app/package.json'), JSON.stringify({ name: 'crabot-decoder-fixture', version: '1.2.3', main: 'unused.js', description: 'Inert decoder regression', author: 'Crabot' }))
  await fs.mkdir(path.join(coreRoot, 'bin'), { recursive: true }); await fs.mkdir(guiRoot)
  await fs.writeFile(path.join(coreRoot, 'bin/crabot.exe'), 'inert native entry; never executed')
  await fs.writeFile(path.join(guiRoot, 'Crabot.exe'), 'inert GUI entry; never executed')
  await fs.mkdir(path.dirname(path.join(coreRoot, relative)), { recursive: true })
  await fs.writeFile(path.join(coreRoot, relative), 'complete long-path payload bytes')
  const record = { schema_version: 1, platform: 'win32', arch: 'x64', selection, gui: {} }
  await packageWindowsInstaller({ root: process.cwd(), source, output, payload: { directory, coreRoot, guiRoot, record }, distribute: true })
  const installers = (await fs.readdir(path.join(output, 'distribution'))).filter(file => file.endsWith('offline-candidate.exe'))
  assert.equal(installers.length, 1)
  const cases = []
  for (const name of ['ordinary', '中文 空格', 'deep']) {
    const target = name === 'deep' ? path.join(root, 'target', ...Array.from({ length: 8 }, (_, index) => 'long-directory-' + index)) : path.join(root, 'target', name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await execute(path.join(output, 'distribution', installers[0]), ['/S', '/D=' + target], { windowsVerbatimArguments: true, timeout: 120000, maxBuffer: 65536 })
    } catch (error) {
      console.log('CRABOT_DECODER_FAILURE ' + JSON.stringify({ name, code: error.code, gui_present: !!await fs.lstat(path.join(target, 'app/releases', selection.gui_id, 'Crabot.exe')).catch(() => null), nested_present: !!await fs.lstat(path.join(target, 'releases', selection.core_id, relative)).catch(() => null) }))
      throw error
    }
    const installed = path.join(target, 'releases', selection.core_id, relative)
    console.log('CRABOT_DECODER_DESTINATION ' + JSON.stringify({ name, target, entries: await fs.readdir(target).catch(error => error.code), default_entries: await fs.readdir(path.join(process.env.USERPROFILE, 'Crabot')).catch(error => error.code) }))
    assert.equal(await fs.readFile(installed, 'utf8'), 'complete long-path payload bytes')
    for (const absent of ['desktop-installation.json', 'current-release.json', 'data', 'CrabotInstaller.exe', 'resources/offline']) {
      await assert.rejects(fs.lstat(path.join(target, absent)), { code: 'ENOENT' })
    }
    cases.push({ name, path_length: installed.length, exact_bytes: true, data_initialized: false, gui_or_core_started: false })
  }
  assert.ok(cases.find(value => value.name === 'deep').path_length > 320)
  console.log('CRABOT_SINGLE_LAYER_DECODER ' + JSON.stringify({ actual_product_nsis: true, cases }))
} finally {
  const cleanup = path.join(root, 'cleanup-shortcut.ps1')
  await fs.writeFile(cleanup, `$p=Join-Path ([Environment]::GetFolderPath('Programs')) 'Crabot.lnk'; if(Test-Path -LiteralPath $p){$s=New-Object -ComObject WScript.Shell; $t=$s.CreateShortcut($p).TargetPath; if($t.StartsWith($env:CRABOT_PROBE_ROOT+'\\',[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $p;}}`)
  await execute(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', cleanup], { env: { ...process.env, CRABOT_PROBE_ROOT: root }, timeout: 30000 })
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
