// Published legacy archives, real dropped UIDs and the ordinary installer. This
// fixture covers stopped profiles and a real original running/stopped set;
// it does not claim interrupted-source restoration or a real model session.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
  || process.env.GITHUB_REPOSITORY !== 'smilefufu/crabot' || process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() !== 0) {
  throw Error('Published legacy acceptance requires an isolated GitHub-hosted Linux root runner')
}
const workspace = await fs.realpath(process.env.GITHUB_WORKSPACE), source = await fs.realpath(process.argv[2]), evidence = path.resolve(process.argv[3])
assert.equal(source, path.join(workspace, '.desktop-build/安装 候选/core'))
assert.equal(evidence, path.join(workspace, '.desktop-build/system-legacy.json'))
const load = file => import(pathToFileURL(path.join(source, file)).href)
const { verifyCoreRelease } = await load('scripts/lib/core-release.mjs')
const { SystemRegistry } = await load('scripts/lib/system-registry.mjs')
const { SystemOperationStore } = await load('scripts/lib/system-operation.mjs')
const { discoverLegacySystemRelease } = await load('scripts/lib/legacy-system-release.mjs')
const { runSystemUser } = await load('scripts/lib/system-user.mjs')
const { assertCoordinatorStopped, coordinatorUnit } = await load('scripts/lib/system-coordinator.mjs')
const { renderSystemUserService } = await load('scripts/lib/system-service.mjs')
const { default: identity } = await load('scripts/lib/process-identity.cjs')
await verifyCoreRelease(source)
const node = path.join(source, '.product-runtime/node/bin/node'), execute = promisify(execFile)
const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', USER: 'root', LOGNAME: 'root', LANG: 'C.UTF-8',
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' }
const run = (binary, args, options = {}) => execute(binary, args, { env, cwd: '/', timeout: 180_000, maxBuffer: 1024 * 1024, ...options })
const releases = [
  { version: 'v2026.10.14.1', size: 439564473, sha256: 'dc665e8fbce97cb3a815beac4931d71b141e042a9052c0a859eda954be452ea5' },
  { version: 'v2026.10.15.1', size: 439576227, sha256: '735c56bdc74b12a67b8d889fa211aa35dc916b20d2b509262d51898307bb3f64' },
]
const selectedVersion = process.argv[4] || 'all'
assert.ok(selectedVersion === 'all' || releases.some(release => release.version === selectedVersion))
const reports = [], ownedOsFiles = ['/etc/crabot', '/usr/local/bin/crabot', '/etc/systemd/user/crabot.service', '/etc/logrotate.d/crabot']
// GitHub images can make this root-owned command directory world-writable.
// Match the shared-install prerequisite only on this disposable hosted runner.
const commandDirectory = await fs.lstat('/usr/local/bin')
assert.ok(commandDirectory.isDirectory() && !commandDirectory.isSymbolicLink()); assert.equal(commandDirectory.uid, 0)
if (commandDirectory.mode & 0o022) await fs.chmod('/usr/local/bin', (commandDirectory.mode & 0o7777) & ~0o022)
console.log('CRABOT_LEGACY_COMMAND_DIRECTORY ' + JSON.stringify({ before: commandDirectory.mode & 0o7777, after: (await fs.stat('/usr/local/bin')).mode & 0o7777 }))
const absent = async file => assert.rejects(fs.lstat(file), { code: 'ENOENT' })
const ptyCode = String.raw`import os,pty,select,signal,sys,time
pid,master=pty.fork()
if pid==0: os.execv('/bin/bash',['/bin/bash',sys.argv[1],'--system',sys.argv[2]])
output=b'';answered=False;status=None;deadline=time.monotonic()+480
try:
 while time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:
   try: chunk=os.read(master,65536)
   except OSError: chunk=b''
   if chunk: output=(output+chunk)[-1048576:]
  if b'[y/N]' in output and not answered: os.write(master,b'y\n');answered=True
  done,value=os.waitpid(pid,os.WNOHANG)
  if done: status=value;break
finally:
 if status is None:
  try: os.killpg(pid,signal.SIGTERM)
  except ProcessLookupError: pass
  time.sleep(.2)
  try: os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError: pass
  os.waitpid(pid,0)
 os.close(master)
sys.stdout.write(output.decode('utf-8','replace'))
if status is None or os.waitstatus_to_exitcode(status)!=0 or not answered: sys.exit(1)
`
async function download(release, file) {
  const url = 'https://github.com/smilefufu/crabot/releases/download/' + release.version + '/crabot-' + release.version + '-linux-x64.tar.gz'
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw Error('Published archive download failed: ' + response.status)
  let size = 0
  await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
    for await (const chunk of chunks) { size += chunk.length; if (size > release.size) throw Error('Published archive exceeds pinned size'); yield chunk }
  }, createWriteStream(file, { flags: 'wx', mode: 0o600 }))
  assert.equal(size, release.size)
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk)
  assert.equal(hash.digest('hex'), release.sha256)
}
for (const release of releases.filter(release => selectedVersion === 'all' || release.version === selectedVersion)) {
  const id = randomUUID().slice(0, 8), base = '/var/lib/crabot-legacy-acceptance-' + id, old = path.join(base, 'old'), managed = path.join(old, '.managed')
  const users = [], registry = new SystemRegistry(), store = new SystemOperationStore(registry)
  const oldRunning = release.version === 'v2026.10.15.1'
  let ownOs = false, ownBase = false, core
  const asUser = (entry, args, overrides = {}, executable = node) => run('/usr/bin/setpriv', ['--reuid=' + entry.uid, '--regid=' + entry.gid, '--init-groups', '--', executable, ...args],
    { env: { PATH: '/usr/bin:/bin', HOME: entry.home, USER: entry.user, LOGNAME: entry.user, LANG: 'C.UTF-8', HTTP_PROXY: env.HTTP_PROXY, HTTPS_PROXY: env.HTTPS_PROXY, ...overrides } })
  console.log('CRABOT_LEGACY_ACCEPTANCE ' + JSON.stringify({ version: release.version, phase: 'preparing' }))
  try {
    for (const file of ownedOsFiles) await absent(file)
    await absent(base)
    const space = await fs.statfs('/var/lib', { bigint: true }); assert.ok(space.bavail * space.bsize >= 12n * 1024n ** 3n, 'require 12GiB before one legacy case')
    await fs.mkdir(base, { mode: 0o755 }); ownBase = true
    // The test accounts consume public fixture code, not the runner's build
    // directory. Keep the same generated helper outside the sealed old release.
    const credentialSource = path.join(workspace, 'crabot-admin/dist/credentials.js'), credentials = path.join(base, 'credentials.js')
    const credentialSourceStat = await fs.stat(credentialSource)
    await fs.chmod(base, 0o755); await fs.copyFile(credentialSource, credentials); await fs.chmod(credentials, 0o644)
    console.log('CRABOT_LEGACY_CREDENTIAL_FIXTURE ' + JSON.stringify({ source_mode: credentialSourceStat.mode & 0o777, copied_mode: (await fs.stat(credentials)).mode & 0o777 }))
    const archive = path.join(base, 'legacy.tar.gz')
    await download(release, archive); await fs.mkdir(old, { mode: 0o755 })
    await run('/bin/tar', ['--extract', '--gzip', '--file=' + archive, '--directory=' + old, '--strip-components=1', '--no-same-owner', '--no-same-permissions'])
    await fs.writeFile(path.join(old, 'VERSION'), release.version + '\n')
    const discovered = await discoverLegacySystemRelease({ root: old }); assert.equal(discovered.version, release.version)
    // These are the old installer's standard OS markers; old business startup
    // is explicit below and confined to these newly created CI accounts.
    await fs.mkdir('/etc/crabot'); ownOs = true
    for (const name of ['registry', 'defaults']) await fs.mkdir('/etc/crabot/' + name)
    await fs.writeFile('/etc/crabot/cluster.version', '1\n')
    await fs.symlink(path.join(old, 'cli.mjs'), '/usr/local/bin/crabot')
    for (let index = 0; index < 2; index++) {
      const user = 'crabotold-' + id + '-' + index
      await run('/usr/sbin/useradd', ['--create-home', '--shell', '/bin/bash', user])
      const entry = registry.accountLookup(user); users.push(entry)
      entry.port_offset = (index + 1) * 100; entry.data_dir = path.join(entry.home, '.crabot/data-' + entry.port_offset)
      // Test data comes from the same-source build; sealed Core deliberately has only the bundled Admin entry.
      const prepare = `import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
        const {newCredentialsFromPassword}=await import(process.argv[1]);const old=process.argv[2],off=Number(process.argv[3]),home=path.join(process.env.HOME,'.crabot'),data=path.join(home,'data-'+off);
        fs.mkdirSync(home,{mode:0o700});fs.mkdirSync(data,{mode:0o755});
        for(const name of ['admin','agent','memory']){const directory=path.join(data,name);fs.mkdirSync(directory,{mode:0o755});const schema=path.join(old,'crabot-'+name,'schema_version');if(fs.existsSync(schema))fs.writeFileSync(path.join(directory,'SCHEMA_VERSION'),fs.readFileSync(schema));}
        const credentials=JSON.stringify(await newCredentialsFromPassword('fixture-legacy-password',{is_temp:false,changed_via:'start'}));
        fs.writeFileSync(path.join(data,'admin/credentials.json'),credentials,{mode:0o600});
        fs.writeFileSync(path.join(data,'agent/preserved.txt'),'original stopped account history');
        fs.writeFileSync(path.join(home,'instance.json'),JSON.stringify({mode:'system',port_offset:off,crabot_home:old,api_key:'fixture-original-private-key'}),{mode:0o600});
        console.log(createHash('sha256').update(credentials).digest('hex'));`
      entry.credentials_sha256 = (await asUser(entry, ['--input-type=module', '-e', prepare, pathToFileURL(credentials).href, old, String(entry.port_offset)])).stdout.trim()
      assert.match(entry.credentials_sha256, /^[a-f0-9]{64}$/)
    }
    await fs.writeFile('/etc/crabot/registry/ports.json', JSON.stringify(users.map(entry => ({ user: entry.user, offset: entry.port_offset }))) + '\n', { mode: 0o664 })
    if (oldRunning) {
      const employee = users[0]
      console.log('CRABOT_LEGACY_ACCEPTANCE ' + JSON.stringify({ version: release.version, phase: 'original-runtime-starting' }))
      // Old system installations use a public system Node, not a desktop-owned
      // interpreter location. Use the same verified bytes outside both releases.
      const legacyNode = path.join(base, 'node')
      await fs.copyFile(node, legacyNode); await fs.chmod(legacyNode, 0o755)
      const probe = `const fs=require('fs'),{spawnSync}=require('child_process');let executable=true;try{fs.accessSync(process.execPath,fs.constants.X_OK)}catch{executable=false}
        const child=spawnSync(process.execPath,['-e','process.stdout.write("child-ok")'],{encoding:'utf8',detached:true,timeout:10000,killSignal:'SIGKILL'});
        console.log(JSON.stringify({uid:process.getuid(),executable,child_code:child.status,child_error:child.error?.code??null,child_ready:child.stdout==='child-ok'}));`
      for (const [role, binary] of [['candidate-node', node], ['public-legacy-node', legacyNode]]) {
        const result = JSON.parse((await asUser(employee, ['-e', probe], {}, binary)).stdout)
        console.log('CRABOT_LEGACY_NODE_PROBE ' + JSON.stringify({ role, ...result }))
        if (role === 'public-legacy-node') { assert.equal(result.child_code, 0); assert.equal(result.child_ready, true) }
      }
      await asUser(employee, [path.join(old, 'scripts/start.mjs'), '-d'], {
        DATA_DIR: employee.data_dir, CRABOT_PORT_OFFSET: String(employee.port_offset), CRABOT_HOME: old,
      }, legacyNode)
    }
    console.log('CRABOT_LEGACY_ACCEPTANCE ' + JSON.stringify({ version: release.version, phase: 'ordinary-installer' }))
    await run('/usr/bin/python3', ['-I', '-B', '-c', ptyCode, path.join(source, 'install.sh'), '--install-dir=' + old], { timeout: 510_000 })
    assert.equal(await fs.readlink('/usr/local/bin/crabot'), path.join(managed, 'bin/crabot'))
    const selected = (await fs.readFile(path.join(managed, 'current-core'), 'utf8')).trim(); core = path.join(managed, 'releases', selected)
    await verifyCoreRelease(core)
    const maintenance = store.maintenance(), job = store.read(store.file(maintenance.id), true)
    assert.equal(job.plan.kind, 'conversion'); assert.equal(job.phase, 'completed'); assert.equal(job.progress.exit_code, 0)
    assert.deepEqual(job.progress.results.map(row => row.state), oldRunning ? ['healthy', 'kept_stopped'] : ['kept_stopped', 'kept_stopped'])
    assert.deepEqual(job.plan.instances.map(item => item.observation.runtime_state), oldRunning ? ['running', 'stopped'] : ['stopped', 'stopped'])
    for (const { observation } of job.plan.instances.filter(item => item.observation.runtime_state === 'running')) {
      for (const original of [observation.controller, observation.mm]) assert.equal(identity.sameProcess(original, identity.inspectProcess(original.pid)), false)
    }
    const entries = registry.read(), generations = new Map(); assert.equal(entries.length, users.length)
    for (const user of users) {
      const entry = entries.find(value => value.uid === user.uid)
      assert.equal(entry.port_offset, user.port_offset); assert.equal(entry.data_dir, user.data_dir); assert.equal(entry.autostart, false)
      const current = await runSystemUser(entry, { root: core, action: 'inspect' })
      assert.equal(current.state, oldRunning && user.uid === users[0].uid ? 'running' : 'stopped')
      generations.set(entry.uid, current.generation)
      if (current.state === 'running') { assert.equal(current.ready, true); assert.equal(current.core_id, selected) }
      const verify = `import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
        const home=path.join(process.env.HOME,'.crabot'),data=path.join(home,'data-'+process.argv[1]),manifest=JSON.parse(fs.readFileSync(path.join(home,'instance.json')));
        if(manifest.api_key!=='fixture-original-private-key'||manifest.crabot_home!==process.argv[2]||manifest.data_dir!==data)throw Error('original private manifest changed');
        if(fs.readFileSync(path.join(data,'agent/preserved.txt'),'utf8')!=='original stopped account history')throw Error('history changed');
        if((fs.statSync(data).mode&511)!==448)throw Error('data root is not private after conversion');
        console.log(createHash('sha256').update(fs.readFileSync(path.join(data,'admin/credentials.json'))).digest('hex'));`
      assert.equal((await asUser(user, ['--input-type=module', '-e', verify, String(user.port_offset), core])).stdout.trim(), user.credentials_sha256)
    }
    // Normal CLI installation can be repeated after a completed conversion.
    await run('/bin/bash', [path.join(source, 'install.sh'), '--system', '--install-dir=' + old], { timeout: 300_000 })
    assert.equal(store.maintenance().id, maintenance.id, 'repeat installer must not create another conversion')
    assert.equal(await fs.readFile('/etc/systemd/user/crabot.service', 'utf8'), renderSystemUserService(managed))
    for (const entry of entries) assert.equal((await runSystemUser(entry, { root: core, action: 'inspect' })).generation, generations.get(entry.uid), 'repeat install does not restart a user')
    const stoppedDeadline = Date.now() + 10_000
    for (;;) {
      try { await assertCoordinatorStopped(job); break }
      catch (error) { if (Date.now() >= stoppedDeadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    const jobFile = store.file(job.plan.id), maintenanceFile = path.join(store.directory, 'maintenance.json')
    const beforePreview = await Promise.all([fs.readFile(jobFile), fs.readFile(maintenanceFile)])
    await run(path.join(managed, 'bin/crabot'), ['system', 'recover', job.plan.id])
    assert.deepEqual(await Promise.all([fs.readFile(jobFile), fs.readFile(maintenanceFile)]), beforePreview, 'recovery preview cannot mutate root records')
    reports.push({ version: release.version, published_archive_sha256: release.sha256, actual_uid_count: users.length,
      ordinary_installer: true, stopped_instances_preserved: true, original_ports_and_data: true, credentials_and_history_preserved: true,
      repeated_install_no_new_job: true, recovery_preview_readonly: true, actual_old_runtime_started: oldRunning, original_running_set_restored: oldRunning, business_model_calls: 0 })
    await fs.writeFile(evidence, JSON.stringify({ schema_version: 1, requested_versions: selectedVersion === 'all' ? releases.map(release => release.version) : [selectedVersion], cases: reports }, null, 2) + '\n')
    console.log('CRABOT_LEGACY_ACCEPTANCE ' + JSON.stringify({ version: release.version, phase: oldRunning ? 'passed-original-running-set-conversion' : 'passed-stopped-conversion' }))
  } catch (error) {
    console.error('CRABOT_LEGACY_ACCEPTANCE ' + JSON.stringify({ version: release.version, phase: 'failed', code: error.code ?? 'ACCEPTANCE_FAILED',
      stdout: typeof error.stdout === 'string' ? error.stdout.slice(-8192) : null, stderr: typeof error.stderr === 'string' ? error.stderr.slice(-8192) : null }))
    for (const user of users) {
      const diagnostic = `const fs=require('node:fs'),path=require('node:path');for(const name of ['mm.stdout.log','mm.stderr.log','supervisor.boot.log']){let fd;try{
        fd=fs.openSync(path.join(process.argv[1],'logs',name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const stat=fs.fstatSync(fd);
        if(!stat.isFile()||stat.uid!==process.getuid()||stat.nlink!==1)continue;const bytes=Buffer.alloc(Math.min(stat.size,16384));fs.readSync(fd,bytes,0,bytes.length,stat.size-bytes.length);
        console.log('CRABOT_LEGACY_OWN_LOG '+name+'\\n'+bytes.toString('utf8'));}catch(error){console.log('CRABOT_LEGACY_OWN_LOG '+name+' '+error.code)}finally{if(fd!==undefined)fs.closeSync(fd)}}`
      const result = await asUser(user, ['-e', diagnostic, user.data_dir], {}, oldRunning ? path.join(base, 'node') : node).catch(() => null)
      if (result) console.error(result.stdout)
    }
    throw error
  } finally {
    if (ownOs) {
      const maintenance = store.maintenance()
      if (maintenance) {
        const record = store.read(store.file(maintenance.id), true)
        try { await assertCoordinatorStopped(record) }
        catch (error) {
          if (error.code !== 'CRABOT_SYSTEM_OPERATION_ACTIVE') throw error
          await run('/usr/bin/systemctl', ['stop', coordinatorUnit(record)])
          await assertCoordinatorStopped(record)
        }
      }
      for (const user of users) {
        await run('/usr/bin/systemctl', ['stop', 'user@' + user.uid + '.service']).catch(() => {})
        await run('/usr/bin/loginctl', ['disable-linger', user.user]).catch(() => {})
      }
      const ids = new Set(users.map(user => String(user.uid)))
      for (const pid of identity.listProcessIds()) {
        const current = identity.inspectProcess(pid)
        if (current && ids.has(current.owner)) throw Error('CI-owned account still has a process; retain fixture instead of deleting data')
      }
      const target = await fs.readlink('/usr/local/bin/crabot')
      assert.ok([path.join(old, 'cli.mjs'), path.join(managed, 'bin/crabot')].includes(target))
      await fs.unlink('/usr/local/bin/crabot')
      for (const file of ['/etc/systemd/user/crabot.service', '/etc/logrotate.d/crabot']) {
        const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (stat) { assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0); await fs.unlink(file) }
      }
      for (const user of users) await run('/usr/sbin/userdel', ['--remove', user.user])
      await fs.rm('/etc/crabot', { recursive: true })
    }
    if (ownBase) await fs.rm(base, { recursive: true })
  }
}
