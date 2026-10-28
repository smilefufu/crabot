// Disposable CI user, unique per-installation key and inert files only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable Windows CI only')
const { default: identity } = await import('../../scripts/lib/process-identity.cjs')
assert.equal(typeof identity.replaceDesktopUninstallEntry, 'function')
assert.equal(typeof identity.removeDesktopUninstallEntry, 'function')
const id = randomUUID(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'Crabot 卸载 & [] '))
const source = { installRoot: root, executable: path.join(root, 'app/releases', randomUUID(), 'Crabot.exe'), version: '1.2.3' }
const target = { ...source, executable: path.join(root, 'app/releases', randomUUID(), 'Crabot.exe'), version: '1.2.4' }
for (const record of [source, target]) { fs.mkdirSync(path.dirname(record.executable), { recursive: true }); fs.writeFileSync(record.executable, 'inert, never execute') }
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const script = String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\Crabot-'+$env:CRABOT_UNINSTALL_FIXTURE_ID,$true)
try {
 if($null -eq $key){[Console]::Out.Write('null');exit 0}
 switch($env:CRABOT_UNINSTALL_FIXTURE_ACTION){
  'custom' {$key.SetValue('UserCustom','keep',[Microsoft.Win32.RegistryValueKind]::String)}
  'clear-custom' {$key.DeleteValue('UserCustom')}
  'tamper' {$key.SetValue('UninstallString','custom command',[Microsoft.Win32.RegistryValueKind]::String)}
  'restore' {$key.SetValue('UninstallString',$env:CRABOT_UNINSTALL_FIXTURE_COMMAND,[Microsoft.Win32.RegistryValueKind]::String)}
  'partial' {$key.DeleteValue('DisplayVersion')}
 }
 $result=@{};foreach($name in $key.GetValueNames()){$result[$name]=@{kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name)}}
 [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress))
}finally{if($null -ne $key){$key.Dispose()}}`
const observe = (action = '', command = '') => JSON.parse(execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
  env: { ...process.env, CRABOT_UNINSTALL_FIXTURE_ID: id, CRABOT_UNINSTALL_FIXTURE_ACTION: action, CRABOT_UNINSTALL_FIXTURE_COMMAND: command },
  encoding: 'utf8', timeout: 15000, windowsHide: true }).trim())
const command = value => `"${value.executable}" --uninstall`
let claimed = false, current = source, custom = false, tampered = false
try {
  assert.equal(observe(), null)
  assert.throws(() => identity.replaceDesktopUninstallEntry('../other', source, source))
  assert.throws(() => identity.replaceDesktopUninstallEntry(id, source, { ...target, installRoot: root + '-other' }))
  assert.equal(observe(), null)
  claimed = true
  assert.equal(identity.replaceDesktopUninstallEntry(id, source, source), true)
  const first = observe()
  assert.equal(Object.keys(first).length, 8)
  assert.deepEqual(first.UninstallString, { kind: 'String', value: command(source) })
  assert.deepEqual(first.NoModify, { kind: 'DWord', value: 1 }); assert.deepEqual(first.NoRepair, { kind: 'DWord', value: 1 })
  assert.equal(first.InstallLocation.value, root); assert.equal(first.DisplayVersion.value, '1.2.3')
  identity.replaceDesktopUninstallEntry(id, source, source); assert.deepEqual(observe(), first)
  custom = true; const customized = observe('custom')
  assert.throws(() => identity.replaceDesktopUninstallEntry(id, source, target)); assert.throws(() => identity.removeDesktopUninstallEntry(id, source))
  assert.deepEqual(observe(), customized); observe('clear-custom'); custom = false
  tampered = true; const changed = observe('tamper')
  assert.throws(() => identity.replaceDesktopUninstallEntry(id, source, target)); assert.throws(() => identity.removeDesktopUninstallEntry(id, source))
  assert.deepEqual(observe(), changed); observe('restore', command(source)); tampered = false
  observe('partial')
  identity.replaceDesktopUninstallEntry(id, source, target); current = target
  const after = observe(); assert.equal(after.DisplayVersion.value, target.version); assert.equal(after.UninstallString.value, command(target))
  identity.replaceDesktopUninstallEntry(id, source, target); assert.deepEqual(observe(), after)
  assert.throws(() => identity.removeDesktopUninstallEntry(id, source)); assert.deepEqual(observe(), after)
  assert.equal(identity.removeDesktopUninstallEntry(id, target), true); assert.equal(observe(), null)
  assert.equal(identity.removeDesktopUninstallEntry(id, target), true); assert.equal(observe(), null)
  console.log('CRABOT_WINDOWS_UNINSTALL_ENTRY ' + JSON.stringify({ actual_hkcu_registry: true, unique_installation: true,
    unicode_paths: true, fixed_interactive_command: true, repeated_registration: true, interrupted_fields_recovered: true,
    custom_entry_preserved: true, foreign_version_preserved: true, repeated_removal: true, product_main_started: false, business_mm_started: false }))
} finally {
  if (claimed) {
    // Restore only changes explicitly made by this finite fixture. Unknown
    // state still fails the exact native remover and is left for CI disposal.
    if (custom) observe('clear-custom')
    if (tampered) observe('restore', command(current))
    if (observe() !== null) identity.removeDesktopUninstallEntry(id, current)
    assert.equal(observe(), null)
  }
  fs.rmSync(root, { recursive: true, force: true })
}
