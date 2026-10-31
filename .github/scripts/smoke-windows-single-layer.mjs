// Exact completed EXE, silent extraction only. No GUI or business Core starts.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { verifyDesktopPrograms } from '../../scripts/lib/desktop-payload.mjs'
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const execute = promisify(execFile), project = path.resolve(process.argv[2])
const info = JSON.parse(await fs.readFile(path.join(project, 'installer-location.json'), 'utf8'))
assert.equal(info.bootstrap, 'windows-first-launch')
const distribution = path.join(project, 'distribution'), installers = (await fs.readdir(distribution)).filter(file => file.endsWith('offline-candidate.exe'))
assert.equal(installers.length, 1)
const root = await fs.mkdtemp(path.join(tmpdir(), 'Crabot exact EXE ')), target = path.join(root, '选择的程序 目录'), started = Date.now()
try {
  await execute(path.join(distribution, installers[0]), ['/S', '/D=' + target], { windowsVerbatimArguments: true, timeout: 600000, maxBuffer: 65536 })
  const originalGui = path.dirname(path.resolve(project, info.executable)), gui = path.join(target, path.relative(path.resolve(project, info.programs), originalGui))
  const pin = JSON.parse(await fs.readFile(path.join(gui, 'resources/desktop-release.json'), 'utf8'))
  const record = JSON.parse(await fs.readFile(path.join(target, 'app/installers', pin.gui_id + '.json'), 'utf8'))
  await verifyDesktopPrograms(path.join(target, 'releases', pin.core_id), gui, record)
  for (const absent of ['data', 'desktop-installation.json', 'current-release.json', 'CrabotInstaller.exe', 'resources/offline']) await assert.rejects(fs.lstat(path.join(target, absent)), { code: 'ENOENT' })
  console.log('CRABOT_WINDOWS_SINGLE_LAYER ' + JSON.stringify({ exact_exe: true, full_gui_and_core_inventory: true, elapsed_ms: Date.now() - started, data_initialized: false, second_installer: false, gui_or_core_started: false }))
} finally {
  const cleanup = path.join(root, 'shortcut.ps1')
  await fs.writeFile(cleanup, `$p=Join-Path ([Environment]::GetFolderPath('Programs')) 'Crabot.lnk';if(Test-Path -LiteralPath $p){$s=New-Object -ComObject WScript.Shell;$t=$s.CreateShortcut($p).TargetPath;if($t.StartsWith($env:CRABOT_PROBE_ROOT+'\\',[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $p;}}`)
  await execute(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', cleanup], { env: { ...process.env, CRABOT_PROBE_ROOT: root }, timeout: 30000 })
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
