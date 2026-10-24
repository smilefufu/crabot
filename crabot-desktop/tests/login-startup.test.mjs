import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LoginStartup } from '../dist/login-startup.js'
import { spawnSync } from 'node:child_process'

async function fixture(t, extra = {}) {
  const configHome = await mkdtemp(path.join(tmpdir(), 'crabot-startup-'))
  t.after(() => rm(configHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const calls = []
  let value = { openAtLogin: false, wasOpenedAtLogin: false, status: 'not-registered', executableWillLaunchAtLogin: false, launchItems: [] }
  const app = { getLoginItemSettings: options => { calls.push(['get', options]); return { ...value,
      launchItems: value.launchItems.map(item => ({ ...item, args: item.args.filter(arg => !arg.startsWith('--')) })) } },
    setLoginItemSettings: options => { calls.push(['set', options]); value = { ...value, openAtLogin: options.openAtLogin, executableWillLaunchAtLogin: options.enabled,
      launchItems: options.path ? [{ name: options.name, path: options.path, args: options.args, scope: 'user', enabled: options.enabled }] : [] } } }
  return { startup: new LoginStartup({ platform: 'linux', executable: '/opt/中文 Crabot/crabot', packaged: true, configHome, app, inspectWindows: executable => {
      const item = value.launchItems.find(item => item.name === 'Crabot' && item.scope === 'user')
      return !item ? 'absent' : item.path.toLowerCase() !== executable.toLowerCase() ? 'different'
        : JSON.stringify(item.args) === '["--background"]' ? 'background' : 'custom'
    }, ...extra }),
    configHome, file: path.join(configHome, 'autostart/crabot.desktop'), calls, state: next => { value = { ...value, ...next } } }
}

test('Ubuntu startup is absent by default and created only on opt-in, with a background argument', async t => {
  const f = await fixture(t)
  assert.equal((await f.startup.get()).enabled, false)
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
  assert.equal((await f.startup.set(true)).enabled, true)
  assert.match(await readFile(f.file, 'utf8'), /^Exec=\/usr\/bin\/env -- "\/opt\/中文 Crabot\/crabot" --background$/m)
  await writeFile(f.file, (await readFile(f.file, 'utf8')) + 'Hidden=true\n')
  assert.equal((await f.startup.get()).enabled, false)
  assert.equal((await f.startup.set(false)).enabled, false)
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
})

test('unknown files and symlinks are preserved, and source mode never writes OS settings', async t => {
  const f = await fixture(t)
  await mkdir(path.dirname(f.file)); await writeFile(f.file, '[Desktop Entry]\nExec=legacy-crabot\n')
  await assert.rejects(f.startup.set(true), /不属于桌面版/)
  assert.match(await readFile(f.file, 'utf8'), /Exec=legacy-crabot/)
  await rm(f.file)
  // File symlinks require extra Windows privileges, so the real symlink check
  // runs on the Unix platforms where this startup format is used.
  if (process.platform !== 'win32') {
    const other = path.join(f.configHome, 'other'); await writeFile(other, 'unrelated')
    await symlink(other, f.file)
    await assert.rejects(f.startup.set(false), /无法识别/)
    assert.equal(await readFile(other, 'utf8'), 'unrelated')
  }
  const source = await fixture(t, { packaged: false, platform: 'win32' })
  assert.equal((await source.startup.get()).supported, false)
  await assert.rejects(source.startup.set(true), /源码开发模式/)
  assert.deepEqual(source.calls, [])
})

test('a desktop marker cannot authorize replacing another executable or a custom entry', async t => {
  const f = await fixture(t)
  await f.startup.set(true)
  const original = await readFile(f.file, 'utf8')
  for (const text of [original.replace('/opt/中文 Crabot/crabot', '/opt/other-crabot/crabot'),
    original + 'Exec=unrelated-program\n', original + '[Desktop Action Other]\nName=Other\n']) {
    await writeFile(f.file, text)
    await assert.rejects(f.startup.get())
    await assert.rejects(f.startup.set(true))
    await assert.rejects(f.startup.set(false))
    assert.equal(await readFile(f.file, 'utf8'), text)
  }
})

test('Windows reads and writes the exact same background entry; OS-disabled startup is not reported enabled', async t => {
  const f = await fixture(t, { platform: 'win32', executable: 'C:\\Users\\中文\\Crabot\\Crabot.exe' })
  assert.equal((await f.startup.set(true)).enabled, true)
  const [, written] = f.calls.find(call => call[0] === 'set')
  assert.deepEqual(written, { openAtLogin: true, path: 'C:\\Users\\中文\\Crabot\\Crabot.exe', args: ['--background'], enabled: true, name: 'Crabot' })
  assert.deepEqual(f.calls.find(call => call[0] === 'get')[1], { path: `"${written.path}"`, args: written.args })
  f.state({ executableWillLaunchAtLogin: true, launchItems: [{ name: 'Other entry', scope: 'user', path: written.path, args: [], enabled: true },
    { name: 'Crabot', scope: 'user', path: written.path, args: written.args, enabled: false }] })
  assert.equal((await f.startup.get()).enabled, false)
})

test('macOS approval remains pending and login launch is hidden based on actual OS launch facts', async t => {
  const f = await fixture(t, { platform: 'darwin' })
  f.state({ openAtLogin: true, status: 'requires-approval', wasOpenedAtLogin: true })
  assert.deepEqual(await f.startup.get(), { supported: true, enabled: false, approvalRequired: true })
  assert.equal(f.startup.launchedAtLogin(), true)
  await f.startup.set(true)
  assert.deepEqual(f.calls.find(call => call[0] === 'set')[1], { openAtLogin: true })
})

test('the actual Ubuntu desktop-entry launcher preserves a quoted executable path and background argument', { skip: process.platform !== 'linux' }, async t => {
  assert.equal(spawnSync('gio', ['version']).status, 0, 'Ubuntu CI must provide its real GIO desktop-entry launcher')
  const root = await mkdtemp(path.join(tmpdir(), 'crabot-startup-exec-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = path.join(root, '中文 space $tick`quote"back\\percent%Crabot')
  const output = path.join(root, 'result')
  await writeFile(executable, '#!/bin/sh\nprintf "%s" "$1" > "$CRABOT_STARTUP_PROBE"\n', { mode: 0o700 })
  const f = await fixture(t, { executable })
  await f.startup.set(true)
  const result = spawnSync('gio', ['launch', f.file], { env: { ...process.env, CRABOT_STARTUP_PROBE: output }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  let value
  for (let attempt = 0; attempt < 100; attempt++) {
    try { value = await readFile(output, 'utf8'); if (value) break } catch (error) { if (error.code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(value, '--background')
})


test('Windows named startup approval is authoritative when legacy openAtLogin is false', async t => {
  const executable = 'C:\\Crabot\\source.exe', f = await fixture(t, { platform: 'win32', executable })
  f.state({ openAtLogin: false, launchItems: [{ name: 'Crabot', scope: 'user', path: executable, args: ['--background'], enabled: true }] })
  assert.equal((await f.startup.get()).enabled, true)
})

function windowsUpdate({ enabled = true, present = true, lostReply = false, path: initialPath = 'C:\\Crabot source\\source.exe', args = ['--background'] } = {}) {
  const source = 'C:\\Crabot source\\source.exe', target = 'C:\\Crabot target\\target.exe', writes = []
  let entry = present ? { name: 'Crabot', scope: 'user', path: initialPath, args, enabled } : null
  const app = {
    getLoginItemSettings: options => ({ openAtLogin: false, wasOpenedAtLogin: false, status: 'not-registered',
      executableWillLaunchAtLogin: !!entry?.enabled,
      launchItems: entry && entry.path.toLowerCase() === (options.path.startsWith('"') ? options.path.slice(1, -1) : options.path.split(' ')[0]).toLowerCase() ? [{ ...entry, args: entry.args.filter(arg => !arg.startsWith('--')) }] : [] }),
    setLoginItemSettings: () => { throw new Error('Updating must never rewrite StartupApproved through Electron') },
  }
  const retargetWindows = (prior, next) => {
    assert.equal(entry.path, prior); assert.deepEqual(entry.args, ['--background'])
    writes.push({ source: prior, target: next }); entry = { ...entry, path: next }
    if (lostReply) throw new Error('OS write reply lost')
  }
  const startup = executable => new LoginStartup({ platform: 'win32', executable, packaged: true, configHome: 'unused', app, retargetWindows,
    inspectWindows: program => !entry ? 'absent' : entry.path.toLowerCase() !== program.toLowerCase() ? 'different'
      : JSON.stringify(entry.args) === '["--background"]' ? 'background' : 'custom' })
  return { source, target, original: startup(source), updated: startup(target), writes, entry: () => entry }
}
for (const enabled of [true, false]) test('Windows retargets only its known source and retains current OS approval: ' + enabled, async () => {
  const f = windowsUpdate({ enabled }), intent = await f.original.captureForUpdate()
  assert.equal(intent, enabled ? 'on' : 'off')
  assert.equal((await f.updated.restoreForUpdate(intent, f.source)).enabled, enabled)
  assert.equal(f.entry().path, f.target); assert.equal(f.writes.length, 1)
  assert.deepEqual(f.writes[0], { source: f.source, target: f.target })
  await f.updated.restoreForUpdate(intent, f.source)
  assert.equal(f.writes.length, 1)
})
test('Windows reads back a completed OS write after a lost reply, and does not override later disablement', async () => {
  const lost = windowsUpdate({ lostReply: true })
  assert.equal((await lost.updated.restoreForUpdate('on', lost.source)).enabled, true)
  assert.equal(lost.writes.length, 1)
  const disabled = windowsUpdate({ enabled: false })
  assert.equal((await disabled.updated.restoreForUpdate('on', disabled.source)).enabled, false)
  assert.equal(disabled.entry().enabled, false)
})
test('absent or unrelated Windows startup cannot be created or overwritten by a saved on intent', async () => {
  for (const options of [{ present: false }, { path: 'C:\\Other\\program.exe' }]) {
    const f = windowsUpdate(options)
    if (options.path) await assert.rejects(f.original.captureForUpdate())
    await assert.rejects(f.updated.restoreForUpdate('on', f.source))
    assert.equal(f.writes.length, 0)
    assert.equal((await f.updated.restoreForUpdate('off', f.source)).enabled, false)
    assert.equal(f.writes.length, 0)
  }
  const custom = windowsUpdate({ args: ['--custom-command'] })
  await assert.rejects(custom.original.captureForUpdate())
  assert.equal(custom.writes.length, 0)
})
for (const disabled of [false, true]) test('Linux retargets the known entry without changing OS Hidden flags: ' + disabled, async t => {
  const f = await fixture(t)
  await f.startup.set(true)
  if (disabled) await writeFile(f.file, (await readFile(f.file, 'utf8')) + 'Hidden=true\n')
  const intent = await f.startup.captureForUpdate()
  const target = new LoginStartup({ platform: 'linux', packaged: true, executable: '/opt/target Crabot/crabot', configHome: f.configHome, app: {} })
  assert.equal((await target.restoreForUpdate(intent, '/opt/中文 Crabot/crabot')).enabled, !disabled)
  assert.match(await readFile(f.file, 'utf8'), /^Exec=.*target Crabot/m)
  assert.equal((await readFile(f.file, 'utf8')).includes('Hidden=true'), disabled)
  const bytes = await readFile(f.file, 'utf8')
  await target.restoreForUpdate(intent, '/opt/中文 Crabot/crabot')
  assert.equal(await readFile(f.file, 'utf8'), bytes)
})
test('Linux off with no entry performs no registration; an on intent cannot resurrect a deleted entry', async t => {
  const f = await fixture(t)
  assert.equal((await f.startup.restoreForUpdate('off', '/opt/old Crabot/crabot')).enabled, false)
  await assert.rejects(f.startup.restoreForUpdate('on', '/opt/old Crabot/crabot'))
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
})
test('macOS target registers itself once, while pending system approval and off never register', async t => {
  const f = await fixture(t, { platform: 'darwin' })
  assert.equal(await f.startup.captureForUpdate(), 'off')
  await f.startup.restoreForUpdate('on', '/opt/old-app')
  assert.equal(f.calls.filter(call => call[0] === 'set').length, 1)
  await f.startup.restoreForUpdate('on', '/opt/old-app')
  assert.equal(f.calls.filter(call => call[0] === 'set').length, 1)
  f.state({ openAtLogin: false, status: 'requires-approval' })
  assert.equal((await f.startup.restoreForUpdate('on', '/opt/old-app')).approvalRequired, true)
  assert.equal(f.calls.filter(call => call[0] === 'set').length, 1)
  f.state({ openAtLogin: false, status: 'not-registered' })
  await f.startup.restoreForUpdate('off', '/opt/old-app')
  await f.startup.restoreForUpdate('approval_required', '/opt/old-app')
  assert.equal(f.calls.filter(call => call[0] === 'set').length, 1)
})
