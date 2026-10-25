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
const previousFixture = installed + '-previous-fixture', legacyEntryFixture = installed + '-legacy-entry-fixture'
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
  await absent(installed); await absent(previousFixture); await absent(legacyEntryFixture)
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
  const { SystemRegistry } = await load('scripts/lib/system-registry.mjs'), { runSystemUser, runLegacySystemAccount } = await load('scripts/lib/system-user.mjs')
  const { SystemOperationStore } = await load('scripts/lib/system-operation.mjs')
  const { default: product } = await load('scripts/lib/product-runtime.cjs'), runtime = product.loadProductRuntime(core)
  const { default: identity } = await load('scripts/lib/process-identity.cjs')
  const registry = new SystemRegistry(); store = new SystemOperationStore(registry); loaded = { core, runSystemUser, identity }
  for (const suffix of ['a', 'b', 'c']) {
    const user = 'crabotci-' + id + '-' + suffix
    await run('/usr/sbin/useradd', ['--create-home', '--shell', '/bin/bash', user])
    const account = (await run('/usr/bin/getent', ['passwd', user])).stdout.trim().split(':')
    users.push({ user, uid: Number(account[2]), gid: Number(account[3]), home: account[5] })
    if (suffix === 'a') await phase('legacy-account-discovery-after-real-uid-drop', async () => {
      // Published entry bytes only: this is not a full old release or old MM test.
      const { materializeLegacyRelease } = await import('../../scripts/lib/__tests__/fixtures/legacy-release.mjs')
      const { discoverLegacySystemRelease } = await load('scripts/lib/legacy-system-release.mjs')
      await fs.mkdir(legacyEntryFixture, { mode: 0o755 })
      const originals = await materializeLegacyRelease(legacyEntryFixture)
      const release = await discoverLegacySystemRelease({ root: legacyEntryFixture }), employee = users.at(-1)
      const uidCommand = args => run('/usr/bin/setpriv', ['--reuid=' + employee.uid, '--regid=' + employee.gid, '--init-groups', '--', runtime.executables.node, ...args],
        { env: { PATH: '/usr/bin:/bin', HOME: employee.home, USER: employee.user, LOGNAME: employee.user } })
      const setup = `const fs=require('fs'),p=require('path');const d=p.join(process.env.HOME,'.crabot');fs.mkdirSync(d,{mode:0o700});fs.writeFileSync(p.join(d,'instance.json'),JSON.stringify({mode:'system',port_offset:100,crabot_home:process.argv[1],data_dir:'/root/must-not-adopt',api_key:'must-not-return'}),{flag:'wx',mode:0o600});`
      await uidCommand(['-e', setup, legacyEntryFixture])
      await assert.rejects(runLegacySystemAccount(employee, { root: core, release, portOffsetHint: 100 }), { code: 'CRABOT_LEGACY_SYSTEM_RUNTIME' })
      const unsetDisplay = `const fs=require('fs'),p=require('path');const file=p.join(process.env.HOME,'.crabot/instance.json');const value=JSON.parse(fs.readFileSync(file));delete value.data_dir;fs.writeFileSync(file,JSON.stringify(value));`
      await uidCommand(['-e', unsetDisplay])
      await assert.rejects(runLegacySystemAccount(employee, { root: core, release, portOffsetHint: 100 }), { code: 'CRABOT_DATA_MISSING' })
      const prepareStopped = `import fs from 'node:fs';import path from 'node:path';const {newCredentialsFromPassword}=await import(process.argv[1]);const data=path.join(process.env.HOME,'.crabot/data-100');fs.mkdirSync(data,{mode:0o755});for(const name of ['admin','agent','memory'])fs.mkdirSync(path.join(data,name),{mode:0o755});fs.writeFileSync(path.join(data,'admin/credentials.json'),JSON.stringify(await newCredentialsFromPassword('fixture-stopped-private',{is_temp:false,changed_via:'start'})),{flag:'wx',mode:0o600});`
      await uidCommand(['--input-type=module', '-e', prepareStopped, pathToFileURL(path.join(core, 'crabot-admin/dist/credentials.js')).href])
      const result = await runLegacySystemAccount(employee, { root: core, release, portOffsetHint: 100 })
      assert.equal(result.uid, employee.uid); assert.equal(result.data_binding, 'verified_stopped')
      assert.equal(result.port_offset, 100); assert.equal(result.runtime_state, 'stopped')
      assert.equal(result.data_dir, path.join(employee.home, '.crabot/data-100'))
      assert.doesNotMatch(JSON.stringify(result), /must-not|api_key|fixture-stopped-private/)
      const unchanged = `const fs=require('fs'),p=require('path');const d=p.join(process.env.HOME,'.crabot/data-100');if((fs.statSync(d).mode&511)!==493||fs.readdirSync(d).sort().join(',')!=='admin,agent,memory'||!fs.readFileSync(p.join(d,'admin/credentials.json'),'utf8').includes('scrypt'))throw Error('read-only discovery changed stopped data');`
      await uidCommand(['-e', unchanged])
      console.log('CRABOT_SYSTEM_LEGACY_STOPPED_BINDING ' + JSON.stringify({ actual_uid: true, standard_existing_data: true, conflicting_display_refused: true, missing_data_not_initialized: true, no_source_mm_started: true }))
      const { collectLegacySystemProcesses, assertLegacySystemProcessCoverage } = await load('scripts/lib/legacy-system-processes.mjs')
      const { planSystemConversion } = await load('scripts/lib/system-conversion.mjs')
      const empty = planSystemConversion({ installRoot: installed, source: release, target: { id: selected, version: JSON.parse(await fs.readFile(path.join(core, 'package.json'), 'utf8')).version }, instances: [] })
      // Real same-UID Node metadata only, not an old business MM. A writable
      // historical registry omitting this UID must not mean no shared consumers.
      const child = spawn('/usr/bin/setpriv', ['--reuid=' + employee.uid, '--regid=' + employee.gid, '--init-groups', '--', runtime.executables.node,
        '-e', "process.stdout.write('metadata-ready');setInterval(()=>{},1000)", '--', 'census-argv-must-not-be-persisted'],
        { cwd: legacyEntryFixture, env: { PATH: '/usr/bin:/bin', HOME: employee.home, USER: employee.user, LOGNAME: employee.user }, stdio: ['ignore', 'pipe', 'inherit'] })
      let original
      try {
        const [ready] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
        assert.equal(ready.toString(), 'metadata-ready'); original = identity.inspectProcess(child.pid)
        assert.equal(original.owner, String(employee.uid))
        const census = collectLegacySystemProcesses(legacyEntryFixture)
        assert.equal(census.find(row => identity.sameProcess(row.process, original))?.uses_source, true)
        assert.equal(JSON.stringify(census).includes('census-argv-must-not-be-persisted'), false)
        assert.throws(() => assertLegacySystemProcessCoverage(empty, census), { code: 'CRABOT_LEGACY_SYSTEM_PROCESSES' })
      } finally {
        if (original && identity.sameProcess(original, identity.inspectProcess(child.pid))) {
          const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
          child.kill('SIGTERM'); await exited
        }
      }
      assertLegacySystemProcessCoverage(empty, collectLegacySystemProcesses(legacyEntryFixture), { stopped: true })
      console.log('CRABOT_SYSTEM_LEGACY_PROCESS_CENSUS ' + JSON.stringify({ actual_uid: true, omitted_uid_refused: true, settled_after_exit: true, mm_started: false }))
      const entry = path.join(legacyEntryFixture, 'scripts/start.mjs')
      await fs.appendFile(entry, '\n// controlled modified legacy entry\n')
      await assert.rejects(runLegacySystemAccount(employee, { root: core, release, portOffsetHint: 100 }), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
      await fs.writeFile(entry, originals['scripts/start.mjs'])
      const { LegacySystemEntryFence } = await load('scripts/lib/legacy-system-fence.mjs')
      const sharedFence = new LegacySystemEntryFence(), operationId = randomUUID()
      const fenced = await sharedFence.fence(release, operationId)
      assert.equal((await fs.stat(path.join(legacyEntryFixture, '.system-takeover'))).mode & 0o777, 0o700)
      // Code observation after UID drop must not need the root-only transaction,
      // and the original discovery-only helper still rejects these changed bytes.
      const codeProbe = `const{discoverFencedLegacySystemRelease}=await import(process.argv[1]);console.log(JSON.stringify(await discoverFencedLegacySystemRelease({root:process.argv[2]})))`
      const observed = await uidCommand(['--input-type=module', '-e', codeProbe, pathToFileURL(path.join(core, 'scripts/lib/legacy-system-release.mjs')).href, legacyEntryFixture])
      assert.deepEqual(JSON.parse(observed.stdout), release)
      await assert.rejects(runLegacySystemAccount(employee, { root: core, release, portOffsetHint: 100 }), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
      await sharedFence.restore(legacyEntryFixture, fenced.id, operationId)
      const cleanup = `const fs=require('fs'),p=require('path');const d=p.join(process.env.HOME,'.crabot');if(fs.readdirSync(d).sort().join(',')!=='data-100,instance.json')throw Error('unexpected fixture data');fs.rmSync(p.join(d,'data-100'),{recursive:true});fs.unlinkSync(p.join(d,'instance.json'));fs.rmdirSync(d);`
      await uidCommand(['-e', cleanup])
    })
    await phase('administrator-open-' + suffix, () => run(runtime.executables.python, ['-I', '-B', '-X', 'utf8', '-c', ptyCode, command, user, 'fixture-pass-' + id]))
    Object.assign(users.at(-1), registry.read().find(entry => entry.user === user))
    assert.equal(users.at(-1).autostart, false)
  }
  const [alice, bob, carol] = users
  const preserved = await fs.readFile(path.join(alice.data_dir, 'admin/credentials.json'))
  await phase('legacy-readable-home-parent-preserved', async () => {
    const parent = path.join(alice.home, '.crabot')
    await run('/usr/bin/setpriv', ['--reuid=' + alice.uid, '--regid=' + alice.gid, '--init-groups', '--', '/bin/chmod', '0755', parent],
      { env: { PATH: '/usr/bin:/bin', HOME: alice.home, USER: alice.user, LOGNAME: alice.user } })
    await run(command, ['system', 'user', 'add', alice.user])
    assert.equal((await fs.stat(parent)).mode & 0o7777, 0o755)
    assert.equal((await fs.stat(alice.data_dir)).mode & 0o7777, 0o700)
  })
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
        await absent(entry.data_dir + '.desktop-backups')
        const receipt = job.progress.results.find(row => row.uid === entry.uid).snapshot
        assert.equal(receipt.backup.id, receipt.id)
        const directory = path.join(entry.data_dir, 'system-control/scoped-recovery', receipt.id)
        const prepared = await fs.readFile(path.join(directory, 'prepared.json'))
        assert.equal(createHash('sha256').update(prepared).digest('hex'), receipt.backup.sha256)
        const completed = JSON.parse(await fs.readFile(path.join(directory, 'completed.json'), 'utf8'))
        assert.equal(completed.id, receipt.id); assert.equal(completed.operation_id, job.plan.id)
        assert.equal(completed.prepared_sha256, receipt.backup.sha256)
        assert.equal((await fs.stat(path.join(directory, 'completed.json'))).uid, entry.uid)
      }
      assert.notEqual(await assertEmployeeRuntime(alice), restartedGeneration)
    } finally { await fs.rm(hook, { force: true }); await new Promise(resolve => server.close(resolve)) }
  })
  if (archiveReport) restartedGeneration = await assertEmployeeRuntime(alice)
  // The stopped Core still has a lingered user manager. Quiesce this disposable
  // fixture UID before usermod, which correctly refuses any live process owner.
  await phase('fixture-stop-user-manager-before-nss-change', async () => {
    assert.equal((await state(carol)).state, 'stopped')
    await run('/usr/bin/systemctl', ['stop', 'user@' + carol.uid + '.service'])
    const processes = (await run('/usr/bin/ps', ['-eo', 'uid=,pid='])).stdout.trim().split('\n')
      .map(line => line.trim().split(/\s+/).map(Number)).filter(([uid]) => uid === carol.uid)
    assert.deepEqual(processes, [], 'NSS fault fixture must have no remaining UID-owned processes')
  })
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
  await phase('coordinator-death-and-protected-real-recovery', async () => {
    const { planSystemBatch } = await import(pathToFileURL(path.join(loaded.core, 'scripts/lib/system-batch.mjs')))
    const plan = await planSystemBatch('start', registry.read(), async entry => {
      registry.verifyAccount(entry); return state(entry)
    })
    await store.prepare(plan)
    const unit = 'crabot-operation-' + plan.id, marker = path.join(installed, 'controlled-root-dispatch'), fixture = path.join(installed, 'controlled-root-coordinator.mjs')
    const script = `import fs from 'node:fs';import {SystemOperationStore} from ${JSON.stringify(pathToFileURL(path.join(loaded.core, 'scripts/lib/system-operation.mjs')).href)};const store=new SystemOperationStore();await store.run(${JSON.stringify(plan.id)},{apply:async()=>{fs.writeFileSync(${JSON.stringify(marker)},'root intent reached; no employee action performed',{mode:0o600});await new Promise(()=>setInterval(()=>{},1000));}});`
    await fs.writeFile(fixture, script, { mode: 0o600 })
    const currentNode = path.join(loaded.core, '.product-runtime/node/bin/node')
    await run('/usr/bin/systemd-run', ['--quiet', '--unit=' + unit, '--service-type=exec', '--property=Restart=no', '--property=TasksAccounting=yes', currentNode, fixture])
    const deadline = Date.now() + 30_000
    while (!await fs.lstat(marker).catch(() => null) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await fs.readFile(marker, 'utf8'), 'root intent reached; no employee action performed')
    const pending = store.read(store.file(plan.id), true)
    assert.equal(pending.progress.current_uid, alice.uid)
    assert.equal((await state(alice)).state, 'stopped', 'fault point precedes any employee start')
    const pid = Number((await run('/usr/bin/systemctl', ['show', unit, '--property=MainPID', '--value'])).stdout.trim())
    const processIdentity = loaded.identity.inspectProcess(pid)
    assert.equal(processIdentity.owner, '0'); assert.equal(processIdentity.executable, await fs.realpath(currentNode))
    assert.equal(loaded.identity.sameProcess(processIdentity, loaded.identity.inspectProcess(pid)), true)
    process.kill(pid, 'SIGKILL')
    for (;;) {
      const response = await run('/usr/bin/systemctl', ['show', unit, '--property=ActiveState', '--value'])
      if (['failed', 'inactive'].includes(response.stdout.trim())) break
      if (Date.now() > deadline) throw new Error('controlled root coordinator did not settle')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const before = await fs.readFile(store.file(plan.id))
    await run(command, ['system', 'recover', plan.id])
    assert.deepEqual(await fs.readFile(store.file(plan.id)), before, 'default recovery is read-only')
    await assert.rejects(run(command, ['system', 'recover', plan.id, '--continue', '--yes'], { timeout: 240_000 }), error => error.code === 1 && error.stdout.includes('observed_stopped'))
    const recovered = store.read(store.file(plan.id), true)
    assert.equal(recovered.phase, 'completed'); assert.equal(recovered.progress.results[0].original_action_unknown, true)
    assert.deepEqual(recovered.progress.results.map(row => row.state), ['observed_stopped', 'started', 'failed'])
    assert.deepEqual(store.maintenance().unsettled, [])
    assert.equal((await state(alice)).state, 'stopped', 'unknown issued start must never replay')
    assert.equal((await state(bob)).ready, true, 'untouched safe user continues under a real recovery unit')
    await assertEmployeeRuntime(bob)
    await assert.rejects(run(currentNode, [fixture]), error => error.code === 1)
    await asUser(bob, ['stop']); assert.equal((await state(bob)).state, 'stopped')
    await fs.rm(fixture); await fs.rm(marker)
  })
  await phase('missing-profile-and-credentials-never-reinitialize', async () => {
    const retained = bob.data_dir + '-ci-retained'
    const ownNode = args => run('/usr/bin/setpriv', ['--reuid=' + bob.uid, '--regid=' + bob.gid, '--init-groups', '--', path.join(loaded.core, '.product-runtime/node/bin/node'), ...args],
      { env: { PATH: '/usr/bin:/bin', HOME: bob.home, USER: bob.user, LOGNAME: bob.user } })
    const rename = (from, to) => ownNode(['-e', "require('fs').renameSync(process.argv[1],process.argv[2])", from, to])
    await absent(retained); await rename(bob.data_dir, retained)
    try {
      await assert.rejects(state(bob), { code: 'CRABOT_DATA_MISSING' })
      for (const args of [['status', '--json'], ['start', '-d']]) await assert.rejects(asUser(bob, args), error => error.code === 1 && /数据目录不存在/.test(error.stderr))
      await assert.rejects(asUser(bob, ['_system-service']), error => error.code === 64 && /数据目录不存在/.test(error.stderr))
      await assert.rejects(run(command, ['system', 'user', 'add', bob.user]), error => error.code === 1 && /数据目录不存在/.test(error.stderr))
      await absent(bob.data_dir)
    } finally {
      if (await fs.lstat(bob.data_dir).catch(() => null)) throw new Error('Missing bound profile was recreated; original retained for CI diagnosis')
      await rename(retained, bob.data_dir)
    }
    assert.equal((await state(bob)).state, 'stopped')
    const credentials = path.join(bob.data_dir, 'admin/credentials.json'), saved = credentials + '.ci-retained'
    await absent(saved); await rename(credentials, saved)
    try {
      await assert.rejects(loaded.runSystemUser(bob, { root: loaded.core, action: 'prepare', input: { password: 'replacement-must-not-take-effect' } }),
        error => error.code === 'CRABOT_SYSTEM_UNVERIFIED' && /原浏览器凭据缺失/.test(error.message))
      await absent(credentials)
    } finally {
      if (await fs.lstat(credentials).catch(() => null)) throw new Error('Existing manifest credentials were reinitialized; original retained for CI diagnosis')
      await rename(saved, credentials)
    }
  })
  await fs.writeFile(evidence, JSON.stringify({ install_root: installed, selected, users: users.map(({ user, uid, gid, port_offset }) => ({ user, uid, gid, port_offset })), events,
    real_systemd: true, real_uid_transitions: true, real_core: true, cli_disconnect_survived: true, real_coordinator_death_recovered_without_replay: true, full_archive_shared_upgrade: Boolean(archiveReport), synthetic_previous_release: Boolean(archiveReport), uses_real_model_provider: false }, null, 2) + '\n')
} catch (error) {
  for (const user of users) {
    if (!user.uid) continue
    const diagnostic = await run('/usr/bin/journalctl', ['--no-pager', '-n', '50', '_UID=' + user.uid, '_SYSTEMD_USER_UNIT=crabot.service']).catch(() => null)
    if (diagnostic) console.error(diagnostic.stdout)
    if (!loaded || !user.data_dir) continue
    // These disposable CI users have no provider or customer data. Read only a
    // fixed, bounded set of startup logs after the same real UID/group drop.
    const probe = `const fs=require('fs'),p=require('path');for(const name of ['agent','agent/shared-request-upgrade.json']){try{const s=fs.lstatSync(p.join(process.argv[1],name));console.log('CRABOT_CI_MARKER_STAT '+JSON.stringify({name,uid:s.uid,actual_uid:process.getuid(),mode:(s.mode&0o777).toString(8),directory:s.isDirectory(),file:s.isFile(),link:s.isSymbolicLink(),nlink:s.nlink}))}catch(e){console.log('CRABOT_CI_MARKER_STAT '+name+' '+e.code)}}for(const name of ['logs/mm.stdout.log','logs/mm.stderr.log','logs/admin-web.log','logs/crabot-agent.log','logs/memory-default.log','logs/system-maintenance.log','system-control/system-maintenance.log']){const file=p.join(process.argv[1],name);let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1)continue;const bytes=Buffer.alloc(Math.min(s.size,65536));fs.readSync(fd,bytes,0,bytes.length,s.size-bytes.length);console.log('CRABOT_CI_STARTUP_LOG '+name+'\\n'+bytes.toString('utf8').split('\\n').slice(-70).join('\\n'))}catch(e){console.log('CRABOT_CI_STARTUP_LOG '+name+' '+e.code)}finally{if(fd!==undefined)fs.closeSync(fd)}}`
    const startup = await run('/usr/bin/setpriv', ['--reuid=' + user.uid, '--regid=' + user.gid, '--init-groups', '--',
      path.join(loaded.core, '.product-runtime/node/bin/node'), '-e', probe, user.data_dir],
      { env: { PATH: '/usr/bin:/bin', HOME: user.home, USER: user.user, LOGNAME: user.user } }).catch(() => null)
    if (startup) console.error(startup.stdout)
    const observed = await state(user).catch(error => ({ error: error.code }))
    console.error('CRABOT_CI_STARTUP_STATE ' + JSON.stringify({ user: user.user, ...observed }))
  }
  throw error
} finally {
  const operation = store?.maintenance()
  if (operation?.recovery_id) await run('/usr/bin/systemctl', ['stop', 'crabot-recovery-' + operation.recovery_id]).catch(() => {})
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
    await fs.rm(legacyEntryFixture, { recursive: true, force: true })
    await fs.rm('/etc/systemd/user/crabot.service', { force: true })
    await fs.rm('/usr/local/bin/crabot', { force: true }); await fs.rm('/etc/logrotate.d/crabot', { force: true })
    await fs.rm('/etc/crabot', { recursive: true, force: true }); await fs.rm(installed, { recursive: true, force: true })
  }
}
