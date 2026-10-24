// Disposable Windows CI user only. Never imports product main or starts a Core.
const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const native = require('../../scripts/lib/process-identity.cjs')
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Only disposable Windows CI may run this probe')
const root = process.argv[2], source = path.join(root, '旧 source/Crabot.exe'), target = path.join(root, '新 target/Crabot.exe')
app.setName('Crabot Login Startup Fixture')
app.setPath('userData', path.join(root, 'profile')); app.setPath('sessionData', path.join(root, 'profile'))
app.setAppUserModelId('com.crabot.login-startup.fixture')
const query = String.raw`$ErrorActionPreference='Stop'
$paths=@('Software\Microsoft\Windows\CurrentVersion\Run','Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run')
$values=@()
foreach($p in $paths){$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p);try{if($null -eq $key -or -not ($key.GetValueNames() -contains 'Crabot')){$values+= $null}else{$v=$key.GetValue('Crabot',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($v -is [byte[]]){$v=[Convert]::ToBase64String($v)};$values+= @{kind=$key.GetValueKind('Crabot').ToString();value=$v}}}finally{if($null -ne $key){$key.Dispose()}}}
[Console]::Out.Write((ConvertTo-Json -InputObject @($values) -Compress))`
const snapshot = () => JSON.parse(execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim())
let claimed = false
void app.whenReady().then(async () => {
  const { LoginStartup } = await import(pathToFileURL(path.resolve(__dirname, '../dist/login-startup.js')).href)
  const initial = snapshot()
  assert.equal(initial.length === 2 && initial.every(value => value === null), true, 'Existing login values must be preserved; this CI user is not disposable')
  for (const file of [source, target]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'finite file, never execute') }
  assert.equal(native.inspectDesktopLoginStartup(source), 'absent')
  assert.throws(() => native.inspectDesktopLoginStartup('not-an-absolute-path'))
  assert.equal(snapshot().every(value => value === null), true)
  const make = (executable, extra = {}) => new LoginStartup({ platform: 'win32', packaged: true, executable, configHome: root, app, ...extra })
  for (const enabled of [true, false]) {
    claimed = true
    app.setLoginItemSettings({ name: 'Crabot', path: source, args: ['--background'], openAtLogin: true, enabled })
    const before = snapshot(), original = make(source), updated = make(target)
    assert.equal(app.getLoginItemSettings({ path: `"${source}"`, args: ['--background'] }).openAtLogin, false)
    const lookup = app.getLoginItemSettings({ path: `"${source}"`, args: ['--background'] })
    console.log('CRABOT_LOGIN_LOOKUP ' + JSON.stringify({ run_present: before[0] !== null, expected_enabled: enabled,
      quoted_matches: lookup.launchItems.length, unquoted_matches: app.getLoginItemSettings({ path: source }).launchItems.length,
      entries: lookup.launchItems.map(item => ({ named: item.name === 'Crabot', user: item.scope === 'user',
        exact_program: item.path.toLowerCase() === source.toLowerCase(), background: JSON.stringify(item.args) === '["--background"]', enabled: item.enabled })) }))
    assert.equal(native.inspectDesktopLoginStartup(source), 'background')
    assert.equal(native.inspectDesktopLoginStartup(target), 'different')
    assert.equal((await original.get()).enabled, enabled)
    assert.equal(await original.captureForUpdate(), enabled ? 'on' : 'off')
    assert.equal((await updated.restoreForUpdate(enabled ? 'on' : 'off', source)).enabled, enabled)
    const after = snapshot()
    assert.equal(native.inspectDesktopLoginStartup(target), 'background')
    assert.equal(JSON.stringify(after[1]) === JSON.stringify(before[1]), true, 'StartupApproved bytes and type must remain unchanged')
    native.retargetDesktopLoginStartup(source, target)
    await updated.restoreForUpdate(enabled ? 'on' : 'off', source)
    assert.equal(JSON.stringify(snapshot()) === JSON.stringify(after), true)
  }
  app.setLoginItemSettings({ name: 'Crabot', path: source, args: ['--custom'], openAtLogin: true, enabled: false })
  const custom = snapshot()
  assert.equal(native.inspectDesktopLoginStartup(source), 'custom')
  assert.throws(() => native.retargetDesktopLoginStartup(source, target))
  await assert.rejects(make(source).captureForUpdate())
  assert.equal(JSON.stringify(snapshot()) === JSON.stringify(custom), true)
  app.setLoginItemSettings({ name: 'Crabot', path: source, args: ['--background'], openAtLogin: true, enabled: false })
  const veto = snapshot()[1]
  const lost = make(target, { retargetWindows: (a, b) => { native.retargetDesktopLoginStartup(a, b); throw new Error('Reply lost') } })
  assert.equal((await lost.restoreForUpdate('on', source)).enabled, false)
  assert.equal(JSON.stringify(snapshot()[1]) === JSON.stringify(veto), true)
  console.log('CRABOT_LOGIN_STARTUP_NATIVE ' + JSON.stringify({ actual_registry: true, named_item_state: true,
    enabled_and_disabled_retarget: true, approval_bytes_preserved: true, custom_preserved: true,
    switches_checked_natively: true, lost_reply_readback: true, real_login_session_verified: false, business_mm_started: false }))
}).then(() => finish(0), error => { console.error(error.stack); finish(1) })
function finish(code) {
  try {
    if (claimed) {
      const items = [source, target].flatMap(executable => app.getLoginItemSettings({ path: `"${executable}"` }).launchItems)
        .filter(item => item.name === 'Crabot' && item.scope === 'user')
      assert.equal(items.length, 1, 'Unknown login change: retain values instead of guessing cleanup')
      assert.ok([source, target].includes(items[0].path))
      const current = snapshot(), allowed = [source, target].flatMap(program => ['--background', '--custom']
        .flatMap(argument => [`"${program}" ${argument}`, `"${program}" "${argument}"`]))
      assert.equal(current[0]?.kind, 'String')
      assert.ok(allowed.includes(current[0].value), 'Unknown command: retain instead of cleaning up')
      app.setLoginItemSettings({ name: 'Crabot', openAtLogin: false })
      assert.equal(snapshot().every(value => value === null), true)
    }
  } catch (error) { console.error(error.stack); code = 1 }
  app.exit(code)
}
