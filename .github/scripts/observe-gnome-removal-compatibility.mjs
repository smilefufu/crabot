// Real default GNOME daemon in a disposable CI session; read-only product query.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import native from '../../scripts/lib/process-identity.cjs'
import { captureLinuxRemovalSystemProcesses } from '../../scripts/lib/desktop-removal-system-processes.mjs'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'linux')
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS)
const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-gnome-session-')))
const home = path.join(root, 'home'), run = path.join(root, 'run'), control = path.join(root, 'keyring'), program = path.join(root, 'program')
for (const folder of [home, run, control, program]) await fs.mkdir(folder, { mode: 0o700 })
let daemon, ended
const report = { daemon_started: false, actual_daemon: true, secrets_created: false, product_mutation: false, default_capability_present: false }
try {
  try { report.default_capability_present = execFileSync('/usr/sbin/getcap', ['/usr/bin/gnome-keyring-daemon'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }).includes('cap_ipc_lock') } catch {}
  const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: run, XDG_DATA_HOME: path.join(home, 'share'), XDG_CONFIG_HOME: path.join(home, 'config') }
  for (const key of ['GNOME_KEYRING_CONTROL', 'GNOME_KEYRING_PID', 'SSH_AUTH_SOCK']) delete env[key]
  daemon = spawn('/usr/bin/gnome-keyring-daemon', ['--foreground', '--components=secrets', '--control-directory=' + control], {
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  ended = once(daemon, 'exit')
  daemon.on('error', () => {})
  const deadline = Date.now() + 10000
  for (;;) {
    assert.equal(daemon.exitCode, null, 'Default GNOME daemon exited before observation')
    try {
      const answer = execFileSync('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
        '--method', 'org.freedesktop.DBus.GetConnectionUnixProcessID', 'org.freedesktop.secrets'], { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 })
      if (Number(answer.match(/uint32 (\d+)/)?.[1]) === daemon.pid) break
    } catch {}
    assert.ok(Date.now() < deadline, 'Default GNOME daemon did not acquire its private session name')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  report.daemon_started = true
  const inspectDaemon = () => { try { return native.inspectProcess(daemon.pid) } catch { return null } }
  const permitSystemUnknowns = captureLinuxRemovalSystemProcesses(program), before = inspectDaemon()
  const result = await native.inspectProgramReferences({ roots: [program], files: [] })
  report.empty_directory = (await fs.readdir(program)).length === 0
  report.explicit_references = result.processes.length
  report.raw_complete = result.complete
  report.daemon_unknown = result.unknown_pids.includes(daemon.pid)
  report.daemon_unknown_stages = result.unknown_details.filter(item => item.pid === daemon.pid).map(item => ({ stage: item.stage, os_error: item.os_error }))
  report.accepted = result.complete || permitSystemUnknowns(result)
  report.daemon_still_alive = daemon.exitCode === null && daemon.signalCode === null && (!before || native.sameProcess(before, inspectDaemon()))
  assert.equal(report.empty_directory, true); assert.equal(report.explicit_references, 0)
  assert.equal(report.daemon_still_alive, true)
  assert.equal(report.accepted, true, 'An empty program directory is blocked in the actual default GNOME session')
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM')
    await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 5000))])
    if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); await ended }
  }
  await fs.mkdir('.desktop-build', { recursive: true })
  await fs.writeFile('.desktop-build/gnome-removal-compatibility.json', JSON.stringify(report, null, 2) + '\n')
  await fs.rm(root, { recursive: true, force: true })
}
