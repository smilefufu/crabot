// Real Linux/systemd/multi-UID acceptance, confined to an ephemeral CI machine.
// No production profile/provider or real model call. Never run on a developer host.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Real system acceptance requires an isolated Linux CI root process')
const execute = promisify(execFile), source = await fs.realpath(process.argv[2]), evidence = path.resolve(process.argv[3])
const id = randomUUID().slice(0, 8), installed = '/var/lib/crabot-system-smoke-' + id
const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', USER: 'root', LOGNAME: 'root', LANG: 'C.UTF-8', GITHUB_ACTIONS: 'true',
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', CRABOT_ROOT_TEST_SECRET: 'root-only-not-for-employees' }
const previousFixture = installed + '-previous-fixture'
const archiveReport = process.argv[4] ? path.resolve(process.argv[4]) : null
const command = path.join(installed, 'bin/crabot'), users = [], events = []
let installOwned = false, loaded, store
const run = (binary, args, options = {}) => execute(binary, args, { env, cwd: '/', timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...options })
async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }) }
async function phase(name, action) {
  const started = Date.now(); console.log('CRABOT_SYSTEM_PHASE ' + JSON.stringify({ name, state: 'starting' }))
  const result = await action(); events.push({ name, duration_ms: Date.now() - started })
  console.log('CRABOT_SYSTEM_PHASE ' + JSON.stringify({ name, state: 'completed', duration_ms: Date.now() - started })); return result
}
const ptyCode = `import os,pty,select,sys,time,signal
command,user,password=sys.argv[1:]
pid,fd=pty.fork()
if pid==0: os.execv(command,[command,"system","user","add",user])
output=b"";sent=0;deadline=time.monotonic()+60
try:
 while time.monotonic()<deadline:
  ready,_,_=select.select([fd],[],[],.2)
  if ready:
   try: chunk=os.read(fd,65536)
   except OSError: chunk=b""
   if not chunk: break
   output+=chunk
   if sent==0 and "浏览器初始密码".encode() in output: os.write(fd,password.encode()+b"\\r");sent=1
   if sent==1 and "再次输入".encode() in output: os.write(fd,password.encode()+b"\\r");sent=2
 else: raise RuntimeError("provisioning prompt timed out")
 _,status=os.waitpid(pid,0)
 if password.encode() in output: raise RuntimeError("password echoed into terminal output")
 if os.waitstatus_to_exitcode(status)!=0: raise RuntimeError(output.decode("utf-8","replace"))
 print(output.decode("utf-8","replace"))
finally:
 os.close(fd)
 try: os.kill(pid,signal.SIGTERM)
 except ProcessLookupError: pass
`
async function asUser(entry, args) {
  const options = { env: { PATH: '/usr/bin:/bin', HOME: entry.home, USER: entry.user, LOGNAME: entry.user, LANG: 'C.UTF-8', GITHUB_ACTIONS: 'true' } }
  return run('/usr/bin/setpriv', ['--reuid=' + entry.uid, '--regid=' + entry.gid, '--init-groups', '--', command, ...args], options)
}
async function state(entry) { return loaded.runSystemUser(entry, { root: loaded.core, action: 'inspect' }) }
async function assertEmployeeRuntime(entry) {
  const record = JSON.parse(await fs.readFile(path.join(entry.data_dir, 'instance-runtime.json'), 'utf8'))
  assert.equal(record.controller.owner, String(entry.uid)); assert.equal(record.mm.owner, String(entry.uid))
  assert.equal((await fs.stat(entry.data_dir)).uid, entry.uid)
  for (const pid of [record.controller.pid, record.mm.pid]) {
    const status = await fs.readFile('/proc/' + pid + '/status', 'utf8')
    assert.match(status, new RegExp('Gid:\\s+' + entry.gid + '\\s+' + entry.gid + '\\s+' + entry.gid + '\\s+' + entry.gid))
    assert.match(status, /^CapEff:\s+0+$/m)
    const vars = await fs.readFile('/proc/' + pid + '/environ', 'utf8')
    assert.equal(vars.includes('CRABOT_ROOT_TEST_SECRET'), false)
    assert.equal(vars.includes('HOME=' + entry.home + '\0'), true)
  }
  return record.generation
}
try {
  await run('/usr/bin/systemctl', ['is-active', 'systemd-logind.service'])
  for (const file of ['/etc/crabot', '/usr/local/bin/crabot', '/etc/systemd/user/crabot.service', '/etc/logrotate.d/crabot']) await absent(file)
  await absent(installed); await absent(previousFixture)
  const parent = await fs.lstat(path.dirname(installed))
  assert.equal(parent.uid, 0); assert.equal(parent.mode & 0o022, 0, 'CI system install must use a root-protected ancestor')
  installOwned = true
  let installationSource = source
  if (archiveReport) {
    await fs.cp(source, previousFixture, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: () => true })
    const { writeCoreRelease, verifyCoreRelease } = await import(pathToFileURL(path.join(source, 'scripts/lib/core-release.mjs')))
    const metadata = await verifyCoreRelease(previousFixture), version = '0.0.0-system-update-fixture'
    for (const file of ['package.json', 'product-runtime.json']) {
      const value = JSON.parse(await fs.readFile(path.join(previousFixture, file), 'utf8'))
      await fs.writeFile(path.join(previousFixture, file), JSON.stringify({ ...value, version }))
    }
    await fs.rm(path.join(previousFixture, 'core-files.json')); await fs.rm(path.join(previousFixture, 'core-release.json'))
    await writeCoreRelease(previousFixture, { ...metadata, version })
    installationSource = previousFixture
  }
  await phase('fresh-bundled-system-install', () => run('/bin/bash', [path.join(installationSource, 'install.sh'), '--system', '--install-dir=' + installed], { timeout: 300_000 }))
  await fs.rm(previousFixture, { recursive: true, force: true })
  const selected = (await fs.readFile(path.join(installed, 'current-core'), 'utf8')).trim(), core = path.join(installed, 'releases', selected)
  const load = file => import(pathToFileURL(path.join(core, file)))
  const { SystemRegistry } = await load('scripts/lib/system-registry.mjs'), { runSystemUser } = await load('scripts/lib/system-user.mjs')
  const { SystemOperationStore } = await load('scripts/lib/system-operation.mjs')
  const { default: product } = await load('scripts/lib/product-runtime.cjs'), runtime = product.loadProductRuntime(core)
  const { default: identity } = await load('scripts/lib/process-identity.cjs')
  const registry = new SystemRegistry(); store = new SystemOperationStore(registry); loaded = { core, runSystemUser, identity }
  for (const suffix of ['a', 'b', 'c']) {
    const user = 'crabotci-' + id + '-' + suffix
    await run('/usr/sbin/useradd', ['--create-home', '--shell', '/bin/bash', user])
    const account = (await run('/usr/bin/getent', ['passwd', user])).stdout.trim().split(':')
    users.push({ user, uid: Number(account[2]), gid: Number(account[3]), home: account[5] })
    await phase('administrator-open-' + suffix, () => run(runtime.executables.python, ['-I', '-B', '-X', 'utf8', '-c', ptyCode, command, user, 'fixture-pass-' + id]))
    Object.assign(users.at(-1), registry.read().find(entry => entry.user === user))
    assert.equal(users.at(-1).autostart, false)
  }
  const [alice, bob, carol] = users
  const preserved = await fs.readFile(path.join(alice.data_dir, 'admin/credentials.json'))
  await phase('repeat-open-preserves-password', () => run(command, ['system', 'user', 'add', alice.user]))
  assert.deepEqual(await fs.readFile(path.join(alice.data_dir, 'admin/credentials.json')), preserved)
  await phase('employee-native-cli-start', () => asUser(alice, ['start', '-d']))
  const firstGeneration = await assertEmployeeRuntime(alice)
  assert.equal((await state(bob)).state, 'stopped')
  await phase('batch-restart-preserves-stopped', () => run(command, ['system', 'restart', '--all', '--yes']))
  let restartedGeneration = await assertEmployeeRuntime(alice)
  assert.notEqual(restartedGeneration, firstGeneration); assert.equal((await state(bob)).state, 'stopped')
  if (archiveReport) await phase('shared-upgrade-real-command-and-archive', async () => {
    const report = JSON.parse(await fs.readFile(archiveReport, 'utf8'))
    assert.equal(report.candidate_only, true); assert.equal(report.roundtrip_verified, true)
    assert.equal(report.file, path.basename(report.file))
    const archive = path.join(path.dirname(archiveReport), report.file), digest = createHash('sha256')
    for await (const chunk of createReadStream(archive)) digest.update(chunk)
    assert.equal(digest.digest('hex'), report.sha256)
    const requests = [], server = createServer((req, res) => {
      requests.push(req.url)
      if (req.url === '/core.tar.gz') createReadStream(archive).pipe(res)
      else if (req.url === '/core.tar.gz.sha256') res.end(report.sha256)
      else { res.statusCode = 404; res.end() }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const hook = path.join(installed, 'fetch-fixture.mjs'), snapshots = new Map()
    for (const entry of users) snapshots.set(entry.uid, await fs.readFile(path.join(entry.data_dir, 'admin/credentials.json')))
    try {
      const base = 'https://github.com/smilefufu/crabot/releases/download/v' + report.version + '/crabot-v' + report.version + '-linux-x64.tar.gz'
      const url = 'http://127.0.0.1:' + server.address().port + '/core.tar.gz'
      await fs.writeFile(hook, `const original=globalThis.fetch;globalThis.fetch=(input,options)=>{const u=String(input);if(u==='https://github.com/smilefufu/crabot/releases/latest')return Promise.resolve(new Response(null,{status:302,headers:{location:'https://github.com/smilefufu/crabot/releases/tag/v${report.version}'}}));if(u===${JSON.stringify(base)})return original(${JSON.stringify(url)},options);if(u===${JSON.stringify(base + '.sha256')})return original(${JSON.stringify(url + '.sha256')},options);throw new Error('Unexpected fixture request');};`)
      const output = await run(command, ['upgrade', '--yes'], { env: { ...env, NODE_OPTIONS: '--import=' + pathToFileURL(hook).href }, timeout: 600_000 })
      assert.match(output.stdout, /作业结束/)
      assert.deepEqual(requests, ['/core.tar.gz', '/core.tar.gz.sha256'])
      const next = (await fs.readFile(path.join(installed, 'current-core'), 'utf8')).trim()
      assert.notEqual(next, selected); loaded.core = path.join(installed, 'releases', next)
      const job = store.read(store.file(store.maintenance().id), true)
      assert.equal(job.plan.kind, 'upgrade'); assert.equal(job.progress.exit_code, 0)
      assert.deepEqual(job.progress.results.map(row => row.state), ['healthy', 'kept_stopped', 'kept_stopped'])
      assert.equal((await state(alice)).core_version, report.version); assert.equal((await state(alice)).ready, true)
      assert.equal((await state(bob)).state, 'stopped'); assert.equal((await state(carol)).state, 'stopped')
      for (const entry of users) {
        assert.deepEqual(await fs.readFile(path.join(entry.data_dir, 'admin/credentials.json')), snapshots.get(entry.uid))
        assert.equal((await fs.stat(entry.data_dir)).uid, entry.uid)
        await absent(path.join(entry.data_dir, 'desktop-maintenance.json'))
        const backups = await fs.readdir(entry.data_dir + '.desktop-backups')
        assert.ok(backups.some(name => !name.startsWith('.')))
      }
      assert.notEqual(await assertEmployeeRuntime(alice), restartedGeneration)
    } finally { await fs.rm(hook, { force: true }); await new Promise(resolve => server.close(resolve)) }
  })
  if (archiveReport) restartedGeneration = await assertEmployeeRuntime(alice)
  // A real NSS identity change must fail this user before any privileged data action.
  let changedUid = Number((await run('/usr/bin/id', ['-u', carol.user])).stdout.trim()) + 10000
  while (await run('/usr/bin/getent', ['passwd', String(changedUid)]).then(() => true, () => false)) changedUid++
  carol.changed_uid = changedUid
  await run('/usr/sbin/usermod', ['--uid', String(changedUid), carol.user])
  await phase('batch-start-partial-user-failure', async () => {
    await assert.rejects(run(command, ['system', 'start', '--all']), error => error.code === 1 && error.stdout.includes(carol.user))
    assert.equal((await state(bob)).ready, true)
    assert.equal(await assertEmployeeRuntime(alice), restartedGeneration, 'already-running instance must not be duplicated')
    await assertEmployeeRuntime(bob)
  })
  await phase('batch-stop-survives-client-disconnect', async () => {
    const client = spawn(command, ['system', 'stop', '--all', '--yes'], { env, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errorOutput = ''
    client.stderr.on('data', bytes => { errorOutput += bytes })
    const submitted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('batch did not submit: ' + errorOutput)), 30_000)
      client.stdout.on('data', bytes => { output += bytes; if (output.includes('已提交作业')) { clearTimeout(timer); resolve() } })
      client.once('error', reject); client.once('exit', code => { if (!output.includes('已提交作业')) { clearTimeout(timer); reject(new Error('client exited before submit: ' + code + ' ' + errorOutput)) } })
    })
    const exited = once(client, 'exit'); await submitted
    const operation = store.maintenance(); assert.notEqual(operation.phase, 'completed', 'disconnect must occur during actual work')
    client.kill('SIGTERM'); await exited
    const deadline = Date.now() + 180_000
    while (store.maintenance().phase !== 'completed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500))
    const done = store.maintenance(), job = store.read(store.file(done.id), true)
    assert.equal(done.phase, 'completed'); assert.equal(job.progress.exit_code, 1)
    assert.deepEqual(job.progress.results.map(row => row.state), ['stopped', 'stopped', 'failed'])
    assert.equal((await state(alice)).state, 'stopped'); assert.equal((await state(bob)).state, 'stopped')
  })
  await phase('employee-stop-stays-stopped', async () => {
    await asUser(alice, ['start', '-d']); await asUser(alice, ['stop'])
    await new Promise(resolve => setTimeout(resolve, 3000)); assert.equal((await state(alice)).state, 'stopped')
  })
  await phase('administrator-disable-preserves-data', async () => {
    await run(command, ['system', 'user', 'remove', alice.user])
    assert.equal(registry.read().find(entry => entry.user === alice.user).enabled, false)
    assert.deepEqual(await fs.readFile(path.join(alice.data_dir, 'admin/credentials.json')), preserved)
  })
  await phase('administrator-reopen-and-autostart-toggle', async () => {
    await run(command, ['system', 'user', 'add', alice.user, '--autostart'])
    const reopened = registry.read().find(entry => entry.user === alice.user)
    assert.equal(reopened.enabled, true); assert.equal(reopened.autostart, true)
    assert.equal(reopened.port_offset, alice.port_offset); assert.equal(reopened.data_dir, alice.data_dir)
    assert.deepEqual(await fs.readFile(path.join(alice.data_dir, 'admin/credentials.json')), preserved)
    assert.equal((await state(alice)).state, 'stopped')
    const autostartState = () => run('/usr/bin/setpriv', ['--reuid=' + alice.uid, '--regid=' + alice.gid, '--init-groups', '--', '/usr/bin/systemctl', '--user', 'is-enabled', 'crabot.service'],
      { env: { PATH: '/usr/bin:/bin', HOME: alice.home, USER: alice.user, XDG_RUNTIME_DIR: '/run/user/' + alice.uid, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + alice.uid + '/bus' } })
    assert.equal((await autostartState()).stdout.trim(), 'enabled')
    await run(command, ['system', 'user', 'add', alice.user, '--no-autostart'])
    assert.equal(registry.read().find(entry => entry.user === alice.user).autostart, false)
    await assert.rejects(autostartState(), error => error.code === 1 && error.stdout.trim() === 'disabled')
    assert.equal((await state(alice)).state, 'stopped')
  })
  await fs.writeFile(evidence, JSON.stringify({ install_root: installed, selected, users: users.map(({ user, uid, gid, port_offset }) => ({ user, uid, gid, port_offset })), events,
    real_systemd: true, real_uid_transitions: true, real_core: true, cli_disconnect_survived: true, full_archive_shared_upgrade: Boolean(archiveReport), synthetic_previous_release: Boolean(archiveReport), uses_real_model_provider: false }, null, 2) + '\n')
} catch (error) {
  for (const user of users) {
    if (!user.uid) continue
    const diagnostic = await run('/usr/bin/journalctl', ['--no-pager', '-n', '35', '_UID=' + user.uid, '--user-unit=crabot.service']).catch(() => null)
    if (diagnostic) console.error(diagnostic.stdout)
  }
  throw error
} finally {
  const operation = store?.maintenance()
  if (operation) await run('/usr/bin/systemctl', ['stop', 'crabot-operation-' + operation.id]).catch(() => {})
  for (const user of users.reverse()) {
    if (loaded && user.uid) await loaded.runSystemUser(user, { root: loaded.core, action: 'stop', operationId: store.maintenance()?.id }).catch(() => {})
    if (user.uid) await run('/usr/bin/systemctl', ['stop', 'user@' + user.uid + '.service']).catch(() => {})
    await run('/usr/bin/loginctl', ['disable-linger', user.user]).catch(() => {})
    if (user.changed_uid) await run('/usr/bin/systemctl', ['stop', 'user@' + user.changed_uid + '.service']).catch(() => {})
  }
  let settled = true
  if (loaded && users.length) {
    const owned = new Set(users.flatMap(user => [user.uid, user.changed_uid].filter(Number.isInteger)))
    const candidates = async () => (await run('/usr/bin/ps', ['-eo', 'uid=,pid='])).stdout.trim().split('\n')
      .map(line => line.trim().split(/\s+/).map(Number)).filter(([uid]) => owned.has(uid))
    // Only disposable UIDs created by this test are eligible for cleanup, with
    // fresh OS identities immediately before any final signal. No name/port kill.
    for (const [, pid] of await candidates()) {
      let identity
      try { identity = loaded.identity.inspectProcess(pid) } catch { settled = false; continue }
      if (identity && owned.has(Number(identity.owner))) {
        try { if (loaded.identity.sameProcess(identity, loaded.identity.inspectProcess(pid))) process.kill(pid, 'SIGKILL') }
        catch { settled = false }
      }
    }
    const deadline = Date.now() + 5000
    for (;;) {
      let alive = false
      for (const [, pid] of await candidates()) {
        try { if (loaded.identity.inspectProcess(pid)) alive = true } catch { alive = true }
      }
      if (!alive) break
      if (Date.now() >= deadline) { settled = false; break }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  if (!settled) throw new Error('CI-owned processes remain unknown; test installation and data retained')
  for (const user of users) await run('/usr/sbin/userdel', ['--remove', user.user]).catch(() => {})
  if (installOwned) {
    await fs.rm(previousFixture, { recursive: true, force: true })
    await fs.rm('/etc/systemd/user/crabot.service', { force: true })
    await fs.rm('/usr/local/bin/crabot', { force: true }); await fs.rm('/etc/logrotate.d/crabot', { force: true })
    await fs.rm('/etc/crabot', { recursive: true, force: true }); await fs.rm(installed, { recursive: true, force: true })
  }
}
