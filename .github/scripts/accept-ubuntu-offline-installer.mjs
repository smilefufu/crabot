// Actual prepared installation, GUI/browser sandbox and built-in MCP on a fresh
// Ubuntu24 CI user. sudo supplies test authorization; graphical Polkit is not UAT.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { homedir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createRequire } from 'node:module'
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.platform, 'linux'); assert.notEqual(process.getuid(), 0)
const project = await fs.realpath(process.argv[2]), info = JSON.parse(await fs.readFile(path.join(project, 'installer-location.json'), 'utf8'))
assert.equal(info.bootstrap, 'gtk4'); assert.equal(info.candidate_only, true); assert.equal(info.release_signed, false)
assert.equal(info.executable, 'ubuntu-native/crabot-installer'); assert.equal(info.payload, 'ubuntu-native/offline')
const bundle = path.join(project, 'ubuntu-native'), native = JSON.parse(await fs.readFile(path.join(bundle, 'native-bootstrap.json'), 'utf8'))
assert.equal(native.commit, process.env.GITHUB_SHA); assert.equal(native.build_os, 'ubuntu-24.04'); assert.equal(native.source_dirty, false)
for (const name of ['crabot-installer', 'crabot-sandbox-helper']) {
  const bytes = await fs.readFile(path.join(bundle, name))
  assert.equal(bytes.length, native.files[name].size)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), native.files[name].sha256)
}
const setting = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns', before = await fs.readFile(setting, 'utf8')
assert.equal(before.trim(), '1', 'Actual restricted Ubuntu kernel required')
const home = await fs.mkdtemp(path.join(homedir(), 'Crabot 安装验收 [] ')), installRoot = path.join(home, '完整 安装 []')
await fs.chmod(home, 0o700)
const allowed = new Set(['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'LC_CTYPE'])
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name)))
Object.assign(env, { HOME: home, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
  XDG_CACHE_HOME: path.join(home, 'cache'), XDG_RUNTIME_DIR: path.join(home, 'run'), GDK_BACKEND: 'x11' })
for (const name of ['config', 'share', 'cache', 'run']) await fs.mkdir(path.join(home, name), { mode: 0o700 })
const exec = promisify(execFile)
const firstWindow = await exec(path.join(bundle, 'crabot-installer'), ['--smoke-test'], { env, timeout: 30_000, maxBuffer: 65536 })
assert.match(firstWindow.stdout, /CRABOT_NATIVE_INSTALLER_WINDOW_READY/)
const node = path.join(bundle, 'offline/core/.product-runtime/node/bin/node')
const child = spawn(node, [path.join(bundle, 'backend/dist/ubuntu-installer-backend.js'), installRoot], { env, stdio: ['pipe', 'pipe', 'pipe'] })
let error, complete = false, authorizations = 0, operations = Promise.resolve(), stderr = ''
child.stdin.on('error', value => { error ??= value })
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192) })
const output = createInterface({ input: child.stdout })
const frames = []
output.on('line', line => {
  operations = operations.then(async () => {
    assert.ok(Buffer.byteLength(line) <= 65536)
    const frame = JSON.parse(line); frames.push(frame.type)
    if (frame.type === 'authorization_required') {
      assert.equal(++authorizations, 1)
      // Product helper remains native and closed; CI sudo is not graphical Polkit.
      await exec('/usr/bin/sudo', ['/usr/bin/env', 'PKEXEC_UID=' + process.getuid(), path.join(bundle, 'crabot-sandbox-helper'), '--register', installRoot],
        { env, timeout: 120_000, maxBuffer: 65536 })
      child.stdin.write('{"action":"authorized"}\n')
    } else if (frame.type === 'complete') complete = true
    else if (frame.type === 'failed') throw new Error('Installation failed: ' + JSON.stringify(frame))
    else assert.equal(frame.type, 'progress')
  }).catch(value => { error ??= value; if (child.stdin.writable) child.stdin.write('{"action":"cancel"}\n') })
})
const cancel = setTimeout(() => { error ??= new Error('Installation acceptance timed out'); if (child.stdin.writable) child.stdin.write('{"action":"cancel"}\n') }, 600_000)
let code
try { [code] = await once(child, 'close'); await operations }
finally { clearTimeout(cancel); output.close() }
if (error) throw error
assert.equal(code, 0, 'Backend exited without completion: ' + stderr)
assert.equal(complete, true); assert.equal(authorizations, 1)
assert.equal(frames.filter(type => type === 'complete').length, 1); assert.equal(frames.at(-1), 'complete')
assert.equal(await fs.readFile(setting, 'utf8'), before)
const require = createRequire(path.join(bundle, 'backend/package.json'))
const installation = require('./dist/bootstrap/scripts/lib/desktop-installation.cjs').readDesktopSelection(installRoot)
const locator = JSON.parse(await fs.readFile(path.join(home, 'config/crabot/desktop-integration/installation.json'), 'utf8'))
assert.equal(locator.install_root, installRoot); assert.equal(locator.installation_id, installation.record.installation_id)
const menu = await fs.readFile(path.join(home, 'share/applications/crabot.desktop'), 'utf8')
assert.ok(menu.includes(installation.record.installation_id))
for (const file of ['mm.pid', 'agent', 'admin']) await assert.rejects(fs.access(path.join(installation.dataDir, file)), { code: 'ENOENT' })
const report = { source: native.commit, actual_native_first_window: true, actual_fresh_installation: true, test_authorizations: authorizations,
  actual_gui_browser_sandbox_and_network: true, actual_bundled_mcp_fetch: true, global_restriction_unchanged: true,
  unique_pair_and_user_entries: true, business_mm_started: false, graphical_polkit: false, gnome_wayland: false, product_uninstall: false }
await fs.writeFile('.desktop-build/ubuntu-installation-report.json', JSON.stringify(report, null, 2) + '\n')
console.log('CRABOT_UBUNTU_INSTALLATION ' + JSON.stringify(report))
// Preserve the owned installed root/policies until this disposable VM ends.
// No production uninstall/retirement guarantee is inferred from test cleanup.
