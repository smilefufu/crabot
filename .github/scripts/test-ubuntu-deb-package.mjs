// Fast real Debian hook regression. Stub executables deliberately do not prove GUI/Core acceptance.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { prepareUbuntuDeb } from '../../scripts/desktop/ubuntu-deb.mjs'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0)
const root = path.resolve('.desktop-build/deb-hooks'), app = path.join(root, 'app'), core = path.join(app, 'resources/core')
for (const file of ['/opt/Crabot', '/usr/bin/crabot', '/etc/apparmor.d/crabot-desktop']) {
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' })
}
await fs.mkdir(path.join(core, 'bin'), { recursive: true })
await fs.copyFile('/bin/sleep', path.join(app, 'crabot-desktop'))
await fs.copyFile('/bin/true', path.join(core, 'bin/crabot'))
const files = {
  '.scrapling-runtime-test/browsers/chromium-123/chrome-linux64/chrome': {},
  '.scrapling-runtime-test/browsers/chromium_headless_shell-123/chrome-headless-shell-linux64/headless_shell': {},
}
for (const file of Object.keys(files)) { await fs.mkdir(path.dirname(path.join(core, file)), { recursive: true }); await fs.copyFile('/bin/true', path.join(core, file)) }
await fs.writeFile(path.join(core, 'product-runtime.json'), JSON.stringify({ files }))
await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'crabot-desktop', version: '0.0.1', description: 'CI-only Debian hook fixture',
  author: { name: 'Crabot Team', email: 'noreply@github.com' }, homepage: 'https://github.com/smilefufu/crabot' }))
const deb = await prepareUbuntuDeb({ core, resources: path.dirname(core), directory: path.join(root, 'debian-package') })
const require = createRequire(path.resolve('crabot-desktop/package.json')), { build, Platform, Arch } = require('electron-builder')
const output = path.join(root, 'output')
await build({ projectDir: root, prepackaged: app, publish: 'never', targets: Platform.LINUX.createTarget('deb', Arch.x64), config: {
  appId: 'com.crabot.desktop', productName: 'Crabot', electronVersion: '44.9.0', publish: null,
  directories: { app: root, output }, linux: { executableName: 'crabot-desktop', icon: path.resolve('crabot-desktop/assets/app.png') },
  deb: { ...deb, depends: [] },
} })
const packages = (await fs.readdir(output)).filter(name => name.endsWith('.deb')); assert.equal(packages.length, 1)
const file = path.join(output, packages[0])
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] })
const install = () => command('/usr/bin/sudo', ['-n', '/usr/bin/dpkg', '--install', file])
let gui
try {
  install()
  assert.match(command('/usr/bin/dpkg-query', ['-W', '-f=${Conffiles}', 'crabot-desktop']), /\/etc\/apparmor.d\/crabot-desktop/)
  gui = spawn('/opt/Crabot/crabot-desktop', ['120'], { stdio: 'ignore' }); await once(gui, 'spawn')
  let refused = false
  try { install() } catch (error) { refused = true; assert.match(error.stdout + error.stderr, /Crabot 仍在运行/) }
  assert.ok(refused); assert.equal(gui.exitCode, null)
  const closed = once(gui, 'close'); gui.kill('SIGTERM'); await closed
  command('/usr/bin/sudo', ['-n', '/bin/sh', '-c', 'echo "# preserved-admin-change" >> /etc/apparmor.d/crabot-desktop'])
  install()
  assert.match(await fs.readFile('/etc/apparmor.d/crabot-desktop', 'utf8'), /preserved-admin-change/)
  command('/usr/bin/sudo', ['-n', '/usr/bin/dpkg', '--remove', 'crabot-desktop'])
  await assert.rejects(fs.stat('/opt/Crabot/crabot-desktop'), { code: 'ENOENT' })
  const loaded = command('/usr/bin/sudo', ['-n', '/bin/cat', '/sys/kernel/security/apparmor/profiles'])
  assert.doesNotMatch(loaded, /^crabot-desktop-(?:gui|chromium|headless) /m)
  console.log(JSON.stringify({ component: 'actual-dpkg-hooks', tiny_fixture_only: true, initial_install: true, running_refused_without_signal: true,
    stopped_reinstall: true, administrator_configuration_retained: true, removal_unloads_only_package_policy: true }))
} finally {
  if (gui?.exitCode === null && gui.signalCode === null) gui.kill('SIGKILL')
  try { command('/usr/bin/sudo', ['-n', '/usr/bin/dpkg', '--purge', 'crabot-desktop']) } catch {}
}
