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
  const app = { getLoginItemSettings: options => { calls.push(['get', options]); return value },
    setLoginItemSettings: options => { calls.push(['set', options]); value = { ...value, openAtLogin: options.openAtLogin, executableWillLaunchAtLogin: options.enabled,
      launchItems: options.path ? [{ name: options.name, path: options.path, args: options.args, scope: 'user', enabled: options.enabled }] : [] } } }
  return { startup: new LoginStartup({ platform: 'linux', executable: '/opt/中文 Crabot/crabot', packaged: true, configHome, app, ...extra }),
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

test('Windows reads and writes the exact same background entry; OS-disabled startup is not reported enabled', async t => {
  const f = await fixture(t, { platform: 'win32', executable: 'C:\\Users\\中文\\Crabot\\Crabot.exe' })
  assert.equal((await f.startup.set(true)).enabled, true)
  const [, written] = f.calls.find(call => call[0] === 'set')
  assert.deepEqual(written, { openAtLogin: true, path: 'C:\\Users\\中文\\Crabot\\Crabot.exe', args: ['--background'], enabled: true, name: 'Crabot' })
  assert.deepEqual(f.calls.find(call => call[0] === 'get')[1], { path: written.path, args: written.args })
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
