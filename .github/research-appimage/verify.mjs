// Runs only in an expendable Ubuntu GitHub VM. Never a product test hook.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0)
const exec = promisify(execFile), base = path.resolve('.desktop-build/appimage-research')
const image = path.join(base, 'Crabot-research.AppImage')
const original = path.resolve('.desktop-build/original/ubuntu-native/offline/core')
const node = path.join(original, '.product-runtime/node/bin/node')
const report = { research_only: true, environment: 'Ubuntu24 GitHub VM/Xvfb, not GNOME human acceptance',
  image: JSON.parse(await fs.readFile(path.join(base, 'packaging.json'), 'utf8')), checks: [] }
const policyText = [], children = []
const restriction = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
const initialRestriction = await fs.readFile(restriction, 'utf8')
assert.equal(initialRestriction.trim(), '1')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function exists(file) { try { await fs.stat(file); return true } catch (e) { if (e.code !== 'ENOENT') throw e; return false } }
async function processInfo(pid) {
  try {
    const root = '/proc/' + pid, text = await fs.readFile(root + '/stat', 'utf8')
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
    const status = await fs.readFile(root + '/status', 'utf8')
    const args = (await fs.readFile(root + '/cmdline', 'utf8')).split('\0').filter(Boolean)
    const tids = await fs.readdir(root + '/task')
    const descendants = (await Promise.all(tids.map(tid => fs.readFile(root + '/task/' + tid + '/children', 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error
    })))).join(' ')
    return { pid, started: fields[19], owner: /^Uid:\s+(\d+)/m.exec(status)?.[1], args,
      executable: await fs.readlink(root + '/exe').catch(error => { if (error.code === 'EACCES') return null; throw error }), no_new_privs: /^NoNewPrivs:\s+1$/m.test(status),
      seccomp: /^Seccomp:\s+2$/m.test(status), map: (await fs.readFile(root + '/uid_map', 'utf8')).trim(),
      children: [...new Set(descendants.trim().split(/\s+/).filter(Boolean).map(Number))] }
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error }
}
async function tree(pid, seen = new Set()) {
  if (seen.has(pid)) return []
  seen.add(pid)
  const own = await processInfo(pid)
  if (!own) return []
  return [own, ...(await Promise.all(own.children.map(child => tree(child, seen)))).flat()]
}
function launch(file, data, gate = false) {
  const env = { ...process.env, HOME: path.join(base, 'home'), DATA_DIR: data,
    XDG_CONFIG_HOME: path.join(base, 'home/config'), XDG_CACHE_HOME: path.join(base, 'home/cache'),
    XDG_DATA_HOME: path.join(base, 'home/share'), CRABOT_RESEARCH_GATE: gate ? 'yes' : '' }
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[key]
  const child = spawn(file, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', mount
  const phases = []
  child.on('error', error => { output += '\n' + error.message })
  const consume = bytes => {
    output = (output + bytes).slice(-128000)
    mount = /CRABOT_RESEARCH_MOUNT=([^\r\n]+)/.exec(output)?.[1]
    for (const line of output.split('\n')) {
      try { const v = JSON.parse(line); if (v.component === 'desktop' && !phases.some(old => old.at === v.at && old.phase === v.phase)) phases.push(v) } catch {}
    }
  }
  child.stdout.on('data', consume); child.stderr.on('data', consume)
  const state = { child, env, phases, get output() { return output }, get mount() { return mount } }
  children.push(state)
  return state
}
async function waitFor(gui, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (gui.child.exitCode !== null || gui.child.signalCode !== null || Date.now() > deadline) return false
    await pause(100)
  }
  return true
}
async function terminate(gui) {
  if (gui.child.exitCode === null && gui.child.signalCode === null) {
    gui.child.kill('SIGKILL')
    await Promise.race([once(gui.child, 'close'), pause(5000)])
  }
  gui.child.stdin.destroy()
}
async function authorize(mount) {
  assert.ok(mount.startsWith('/tmp/.mount_') || mount.startsWith('/tmp/appimage_'), 'Unexpected official runtime mount: ' + mount)
  const runtime = JSON.parse(await fs.readFile(path.join(mount, 'resources/core/product-runtime.json'), 'utf8'))
  const paths = [path.join(mount, 'crabot-desktop'), ...Object.keys(runtime.files)
    .filter(name => /\/browsers\/(?:chromium-[0-9]+\/chrome-linux(?:64)?\/chrome|chromium_headless_shell-[0-9]+\/chrome-headless-shell-linux(?:64)?\/headless_shell)$/.test(name))
    .map(name => path.join(mount, 'resources/core', name))]
  for (const executable of paths) {
    assert.ok(!/["\\\r\n\0]/.test(executable)); assert.ok((await fs.stat(executable)).isFile())
    const name = 'crabot-appimage-research-' + createHash('sha256').update(executable).digest('hex').slice(0, 20)
    const policy = `abi <abi/4.0>,\nprofile ${name} "${executable}" flags=(unconfined) { userns, }\n`
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sudo', ['-n', '/usr/sbin/apparmor_parser', '-r'], { stdio: ['pipe', 'pipe', 'pipe'] })
      let error = ''; child.stderr.on('data', bytes => { error += bytes }); child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(error)))
      child.stdin.end(policy)
    })
    policyText.push(policy)
  }
}
const data = path.join(base, 'data')
await fs.mkdir(data, { recursive: true, mode: 0o700 }); await fs.mkdir(path.join(base, 'home'), { mode: 0o700 })
const noAuth = launch(image, path.join(base, 'baseline-data'))
await waitFor(noAuth, () => noAuth.phases.some(v => ['ready', 'error', 'migration_required'].includes(v.phase)), 20000)
report.checks.push({ name: 'ordinary_unchanged_system_launch', ready: noAuth.phases.some(v => v.phase === 'ready'),
  exit: noAuth.child.exitCode, signal: noAuth.child.signalCode, output: noAuth.output.slice(-12000) })
await terminate(noAuth)
let gui, captured = [], server
try {
  gui = launch(image, data, true)
  if (!await waitFor(gui, () => Boolean(gui.mount))) throw new Error('AppImage runtime could not mount: ' + gui.output)
  const firstMount = gui.mount
  await authorize(firstMount)
  gui.child.stdin.write('continue\n')
  const ready = await waitFor(gui, () => gui.phases.some(v => ['ready', 'error', 'migration_required'].includes(v.phase)), 180000)
  report.checks.push({ name: 'exact_path_authorized_gui', ready: ready && gui.phases.some(v => v.phase === 'ready'),
    phases: gui.phases, output: gui.output.slice(-12000), test_only_system_authorization: true })
  if (!gui.phases.some(v => v.phase === 'ready')) throw new Error('Research GUI was not ready')
  const actual = (await tree(gui.child.pid)).filter(p => p.args.includes('--type=renderer'))
  const hostMap = (await fs.readFile('/proc/self/uid_map', 'utf8')).trim()
  report.checks.push({ name: 'gui_renderer_kernel_sandbox', renderers: actual.map(p => ({ pid: p.pid, no_new_privs: p.no_new_privs, seccomp: p.seccomp,
    distinct_user_namespace: p.map !== hostMap, disabled: p.args.some(a => a === '--no-sandbox') })) })
  const core = path.join(firstMount, 'resources/core')
  const cli = async (...args) => (await exec(path.join(core, '.product-runtime/node/bin/node'), [path.join(core, 'cli.mjs'), ...args],
    { env: gui.env, timeout: 90000, maxBuffer: 2000000 })).stdout
  const status = JSON.parse(await cli('status', '--json'))
  assert.equal(status.running, true)
  const record = JSON.parse(await fs.readFile(path.join(data, 'instance-runtime.json'), 'utf8'))
  for (const member of Object.values(record).filter(v => v && typeof v === 'object' && Number.isSafeInteger(v.pid))) captured.push(...await tree(member.pid))
  await fs.writeFile(path.join(data, 'appimage-research-sentinel.txt'), 'preserve this synthetic data\n')
  const credentials = path.join(data, 'appimage-research-secret.txt')
  await fs.writeFile(credentials, randomBytes(32), { mode: 0o600 })
  const credentialHash = createHash('sha256').update(await fs.readFile(credentials)).digest('hex')
  report.checks.push({ name: 'bundled_cli_same_instance', running: status.running, data_dir: status.data_dir })
  const token = randomBytes(32).toString('hex'), network = [], browserProcesses = []
  let browserPid
  server = createServer(async (req, res) => {
    const role = req.url?.split('/').at(-1)
    if (!req.url?.startsWith('/' + token + '/') || !['chromium', 'scrapling'].includes(role)) { res.writeHead(404).end(); return }
    if (req.method === 'POST') {
      const processes = await tree(browserPid)
      browserProcesses.push({ role, renderers: processes.filter(p => p.args.includes('--type=renderer')).map(p => ({ pid: p.pid,
        no_new_privs: p.no_new_privs, seccomp: p.seccomp, distinct_user_namespace: p.map !== hostMap, disabled: p.args.includes('--no-sandbox') })) })
      network.push(role); res.end('verified'); return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end('<title>Crabot</title><body>Crabot<script>fetch(location.href,{method:"POST"}).then(r=>r.text()).then(()=>document.body.dataset.ready="yes")</script>')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const runtime = JSON.parse(await fs.readFile(path.join(core, 'product-runtime.json'), 'utf8'))
  const browser = spawn(path.join(core, runtime.executables.python), ['-I', '-B', path.resolve('.github/research-appimage/browser.py'), core,
    `http://127.0.0.1:${server.address().port}/${token}`], { env: gui.env, stdio: ['ignore', 'pipe', 'pipe'] })
  browserPid = browser.pid; let browserOutput = ''
  browser.stdout.on('data', b => { browserOutput = (browserOutput + b).slice(-32000) }); browser.stderr.on('data', b => { browserOutput = (browserOutput + b).slice(-32000) })
  const timer = setTimeout(() => browser.kill('SIGTERM'), 150000)
  const [browserCode] = await once(browser, 'close'); clearTimeout(timer)
  report.checks.push({ name: 'browser_and_upstream_mcp_component', code: browserCode, network, observations: browserProcesses, output: browserOutput })
  server.closeAllConnections(); await new Promise(done => server.close(done)); server = undefined
  const main = (await tree(gui.child.pid)).find(p => p.executable === path.join(firstMount, 'crabot-desktop') && !p.args.some(a => a.startsWith('--type=')))
  assert.ok(main)
  process.kill(main.pid, 'SIGKILL') // Deliberate GUI crash; Core must retain its independent lifetime.
  await pause(4000)
  const mm = record.mm && await processInfo(record.mm.pid)
  let health
  try { health = (await fetch('http://127.0.0.1:19000/health', { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) })).status } catch { health = null }
  let cliAfterCrash
  try { cliAfterCrash = { works: true, result: JSON.parse(await cli('status', '--json')).running } }
  catch (error) { cliAfterCrash = { works: false, code: error.code, message: error.message.slice(0, 2000) } }
  report.checks.push({ name: 'gui_crash_background_core', mm_same_process: Boolean(mm && mm.started === captured.find(v => v.pid === mm.pid)?.started),
    mount_retained: await exists(firstMount), core_entry_available: await exists(path.join(core, 'cli.mjs')), health_status: health, cli: cliAfterCrash })
  // Stop only the exact captured synthetic process tree if its mounted CLI vanished.
  try { await cli('stop') } catch {}
  await terminate(gui)
  for (const member of captured) {
    const current = await processInfo(member.pid)
    if (current?.started === member.started && current.owner === String(process.getuid())) try { process.kill(member.pid, 'SIGTERM') } catch {}
  }
  await pause(3000)
  async function retryImage(file, name) {
    gui = launch(file, data, true)
    assert.equal(await waitFor(gui, () => Boolean(gui.mount)), true)
    await authorize(gui.mount); gui.child.stdin.write('continue\n')
    await waitFor(gui, () => gui.phases.some(v => ['ready', 'error', 'migration_required'].includes(v.phase)), 60000)
    report.checks.push({ name, same_version_not_upgrade: true, mount_changed: firstMount !== gui.mount,
      ready: gui.phases.some(v => v.phase === 'ready'), phases: gui.phases, output: gui.output.slice(-8000),
      sentinel_retained: await fs.readFile(path.join(data, 'appimage-research-sentinel.txt'), 'utf8') === 'preserve this synthetic data\n',
      synthetic_secret_retained: createHash('sha256').update(await fs.readFile(credentials)).digest('hex') === credentialHash })
    await terminate(gui)
  }
  await retryImage(image, 'same_image_ordinary_reopen')
  await fs.rename(image, image + '.saved')
  await fs.copyFile(image + '.saved', image)
  await retryImage(image, 'same_path_same_version_image_replacement')
  const moved = path.join(base, 'Moved Crabot.AppImage'); await fs.rename(image, moved)
  await retryImage(moved, 'moved_appimage_same_data')
} catch (error) { report.failure = { message: error.message, code: error.code } }
finally {
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  for (const child of children) await terminate(child)
  // VM-only cleanup, recheck OS start identity before signalling this experiment's processes.
  for (const member of captured) {
    const current = await processInfo(member.pid)
    if (current?.started === member.started && current.owner === String(process.getuid())) try { process.kill(member.pid, 'SIGKILL') } catch {}
  }
  for (const policy of policyText) {
    const child = spawn('/usr/bin/sudo', ['-n', '/usr/sbin/apparmor_parser', '-R'], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.stdin.end(policy); await once(child, 'close')
  }
  report.global_restriction_unchanged = await fs.readFile(restriction, 'utf8') === initialRestriction
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('CRABOT_APPIMAGE_RESEARCH ' + JSON.stringify(report))
}
