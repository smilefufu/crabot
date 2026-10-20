// Controlled process ownership fixture; no real MM, Admin, provider or user data.
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import assert from 'node:assert/strict'

const checkout = process.argv[2], mode = process.argv[3] ?? 'updater'
const expectedCompletion = mode === 'updater' || mode === 'registry-delay' || mode === 'unreadable' || mode === 'cleanup-race' || mode === 'registration-delay' || mode === 'admin-registration-delay'
const { default: identity } = await import(pathToFileURL(path.join(checkout, 'scripts/lib/process-identity.cjs')))
const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-maintenance-fixture-')))
for (const directory of ['scripts', 'data', 'pids', 'crabot-core/dist', 'crabot-admin/dist']) await fs.mkdir(path.join(root, directory), { recursive: true })
const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
const url = file => pathToFileURL(path.join(checkout, file)).href
const prefix = role => `import{writeFileSync}from'node:fs';import identity from ${JSON.stringify(url('scripts/lib/process-identity.cjs'))};writeFileSync(${JSON.stringify(path.join(root, 'pids', role + '.json'))},JSON.stringify(identity.inspectProcess(process.pid)));`
const delayedAdmin = mode === 'admin-registration-delay'
const elapsedGraceClock = !expectedCompletion ? `
import{SUPERVISOR_FORCE_TIMEOUT_MS}from ${JSON.stringify(url('scripts/lib/supervisor-shutdown.mjs'))};
const originalNow=Date.now;
Date.now=()=>originalNow()+(existsSync(${JSON.stringify(path.join(root, 'elapsed-grace'))})?SUPERVISOR_FORCE_TIMEOUT_MS*2:0);
` : ''
const adminWarmup = delayedAdmin ? `
const early=()=>writeFileSync(${JSON.stringify(path.join(root, 'early-admin-message'))},'received before handler');
process.on('message',early);
writeFileSync(${JSON.stringify(path.join(root, 'admin-warming'))},'warming');
const deadline=Date.now()+5000;
while(!existsSync(${JSON.stringify(path.join(root, 'mm-registered'))})){
  if(Date.now()>deadline)throw new Error('fixture MM registration marker missing');
  await new Promise(resolve=>setTimeout(resolve,25));
}
await new Promise(resolve=>setTimeout(resolve,400));
process.removeListener('message',early);
` : ''
const waitForAdminWarmup = delayedAdmin ? `
while(!existsSync(${JSON.stringify(path.join(root, 'admin-warming'))}))await new Promise(resolve=>setTimeout(resolve,25));
` : ''
await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}')
await fs.writeFile(path.join(root, 'cli.mjs'), prefix('cli') + `import{existsSync}from'node:fs';${elapsedGraceClock}import{stopInstance}from ${JSON.stringify(url('scripts/lib/instance-controller.mjs'))};${mode === 'unreadable' ? "identity.inspectProcessArguments=()=>{throw new Error('unreadable fixture')}" : ''};try{await stopInstance(${JSON.stringify(path.join(root, 'data'))});writeFileSync(${JSON.stringify(path.join(root, 'done'))},'stopped')}catch(error){if(${JSON.stringify(mode)}!=='unreadable'||error.code!=='CRABOT_STOP_UNKNOWN')throw error;writeFileSync(${JSON.stringify(path.join(root, 'done'))},'unknown-before-stop')};`)
await fs.writeFile(path.join(root, 'scripts/ui-upgrade.mjs'), prefix('updater') + `import{spawn}from'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(path.join(root, 'cli.mjs'))},'stop'],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));`)
const updaterArgs = [path.join(root, 'scripts/ui-upgrade.mjs'), ...(mode === 'extra-args' ? ['unexpected'] : [])]
await fs.writeFile(path.join(root, 'crabot-admin/dist/main.js'), prefix('admin') + `import{spawn}from'node:child_process';import{existsSync}from'node:fs';${adminWarmup}process.once('message',()=>{writeFileSync(${JSON.stringify(path.join(root, 'admin-start-received'))},'received');const child=spawn(process.execPath,${JSON.stringify(updaterArgs)},{detached:true,stdio:'inherit'});child.unref()});writeFileSync(${JSON.stringify(path.join(root, 'admin-ready'))},'ready');process.send('ready');setInterval(()=>{},1000);`)
await fs.writeFile(path.join(root, 'crabot-core/dist/main.js'), prefix('mm') + `
import{spawn}from'node:child_process';import{once}from'node:events';import{createServer}from'node:http';import{existsSync}from'node:fs';
import{inspectInstance}from ${JSON.stringify(url('scripts/lib/instance-runtime.mjs'))};
import{ModuleRuntimeRegistry}from ${JSON.stringify(url('crabot-core/dist/module-runtime-registry.js'))};
const registry=new ModuleRuntimeRegistry(${JSON.stringify(path.join(root, 'data'))});await registry.initialize();
const admin=spawn(process.execPath,[${JSON.stringify(path.join(root, 'crabot-admin/dist/main.js'))}],{stdio:['ignore','inherit','inherit','ipc']});
const adminReady=once(admin,'message');void adminReady.catch(()=>{});
const runtimeId=registry.createRuntimeId();${mode === 'registry-delay' ? 'await new Promise(resolve=>setTimeout(resolve,16000));' : ''}await registry.recordSpawn({moduleId:${JSON.stringify(mode === 'agent-parent' ? 'crabot-agent' : 'admin-web')},runtimeId,rootPid:admin.pid,modulePort:23456});
let stopping=false;async function stop(){if(stopping)return;stopping=true;const exited=once(admin,'exit');admin.kill();await exited;await registry.removeRuntime(runtimeId);process.exit(0)}
process.on('SIGTERM',stop);createServer((req,res)=>{if(req.url==='/shutdown'){res.end(JSON.stringify({success:true}));void stop()}else res.end('{}')}).listen(${port},'127.0.0.1',async()=>{
writeFileSync(${JSON.stringify(path.join(root, 'mm-listening'))},'listening');
const deadline=Date.now()+5000;
for(;;){const current=inspectInstance(${JSON.stringify(path.join(root, 'data'))});if(current.state==='running'&&current.record.mm?.pid===process.pid)break;if(Date.now()>=deadline)throw new Error('fixture MM registration timed out');await new Promise(resolve=>setTimeout(resolve,25))}
${waitForAdminWarmup}
writeFileSync(${JSON.stringify(path.join(root, 'mm-registered'))},'registered');
const[ready]=await adminReady;
if(ready!=='ready')throw new Error('fixture Admin readiness missing');
writeFileSync(${JSON.stringify(path.join(root, 'admin-start-sent'))},'sent');admin.send('start')});
`)
await fs.writeFile(path.join(root, 'controller.mjs'), prefix('controller') + `
import{spawn}from'node:child_process';import{existsSync}from'node:fs';import{createInstanceRuntime,recordMmProcess}from ${JSON.stringify(url('scripts/lib/instance-runtime.mjs'))};
const data=${JSON.stringify(path.join(root, 'data'))};const record=createInstanceRuntime({dataDir:data,root:${JSON.stringify(root)},mmPort:${port}});
const mm=spawn(process.execPath,[${JSON.stringify(path.join(root, 'crabot-core/dist/main.js'))}],{stdio:'inherit'});
${mode === 'registration-delay' ? `const deadline=Date.now()+5000;while(!existsSync(${JSON.stringify(path.join(root, 'mm-listening'))})){if(Date.now()>deadline)throw new Error('fixture server did not listen');await new Promise(resolve=>setTimeout(resolve,25))}await new Promise(resolve=>setTimeout(resolve,400));` : ''}
recordMmProcess(data,record.generation,mm.pid);
process.on('SIGTERM',()=>mm.kill());mm.on('exit',code=>process.exit(code??1));
`)
const child = spawn(process.execPath, [path.join(root, 'controller.mjs')], { stdio: ['ignore', 'ignore', 'pipe'] })
const exited = once(child, 'exit')
let stderr = ''; child.stderr.on('data', value => { stderr += value })
let passed = false, attempted = false, negativeSettled = false, elapsedGraceSimulated = false
async function actorSettled(role) {
  try {
    const expected = JSON.parse(await fs.readFile(path.join(root, 'pids', role + '.json'), 'utf8'))
    return !identity.sameProcess(expected, identity.inspectProcess(expected.pid))
  } catch { return false } // Unknown is never proof of exit, including fixtures.
}
try {
  // Preparing the fake registry is not a stop attempt. Keep its bounded readiness
  // wait separate from the unchanged maintenance assertion window below.
  const startupDeadline = Date.now() + 30000
  let armed = false
  while (Date.now() < startupDeadline) {
    if (await fs.access(path.join(root, 'admin-start-sent')).then(() => true, () => false)) { armed = true; break }
    if (child.exitCode !== null || child.signalCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(armed, true, 'Fixture never armed maintenance; mode=' + mode + '; markers=' + JSON.stringify(await fs.readdir(root)))
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    attempted = await fs.access(path.join(root, 'pids/cli.json')).then(() => true, () => false)
    if (await fs.access(path.join(root, 'done')).then(() => true, () => false)) { passed = true; break }
    if (!expectedCompletion && attempted && await actorSettled('controller') && await actorSettled('mm')) {
      // Only these fake Core processes are already OS-confirmed gone. Advance
      // their fake caller's clock to exercise untrusted-descendant termination;
      // never shorten a live Core's real graceful shutdown window.
      if (!elapsedGraceSimulated) { await fs.writeFile(path.join(root, 'elapsed-grace'), 'fake-core-already-exited'); elapsedGraceSimulated = true }
      if (await actorSettled('cli') && await actorSettled('updater')) { negativeSettled = true; break }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const diagnostic = 'mode=' + mode + '; markers=' + JSON.stringify(await fs.readdir(root)) + '; ' + stderr
  assert.equal(attempted, true, 'Fixture never exercised its stop CLI; ' + diagnostic)
  assert.equal(passed, expectedCompletion, 'Incorrect maintenance ownership; ' + diagnostic)
  if (!expectedCompletion) assert.equal(negativeSettled, true, 'Untrusted helper did not provably settle after fake Core exit; ' + diagnostic)
  if (delayedAdmin) assert.equal(await fs.access(path.join(root, 'early-admin-message')).then(() => true, () => false), false)
  if (mode === 'unreadable') {
    const controller = JSON.parse(await fs.readFile(path.join(root, 'pids/controller.json'), 'utf8'))
    assert.ok(identity.sameProcess(controller, identity.inspectProcess(controller.pid)), 'Unknown argv stopped the controller')
    assert.equal(await fs.readFile(path.join(root, 'done'), 'utf8'), 'unknown-before-stop')
  }
  console.log('CONTROLLED_UI_MAINTENANCE_STOP ' + JSON.stringify({ passed: true, completed: passed, mode, business_mm: false, elapsed_grace_simulated: elapsedGraceSimulated }))
} finally {
  const files = await fs.readdir(path.join(root, 'pids'))
  const unresolved = []
  if (mode === 'cleanup-race') {
    const inspect = identity.inspectProcess, observed = new Set()
    identity.inspectProcess = pid => {
      if (!observed.has(pid)) { observed.add(pid); throw Object.assign(new Error('exiting fixture'), { code: 'CRABOT_PROCESS_IDENTITY' }) }
      return inspect(pid)
    }
  }
  const cleanup = await Promise.allSettled(files.map(async file => {
    const expected = JSON.parse(await fs.readFile(path.join(root, 'pids', file), 'utf8'))
    const deadline = Date.now() + 5000
    let settled = false
    while (Date.now() < deadline) {
      try {
        const actual = identity.inspectProcess(expected.pid)
        if (!identity.sameProcess(expected, actual)) { settled = true; break }
        // Signal only the exact saved fixture identity; unknown/reused PIDs
        // never receive a signal, even during test cleanup.
        try { process.kill(expected.pid, 'SIGKILL') } catch (error) { if (!['ESRCH', 'EPERM', 'EACCES'].includes(error.code)) throw error }
      } catch (error) { if (error.code !== 'CRABOT_PROCESS_IDENTITY') throw error }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!settled) unresolved.push(expected.pid)
  }))
  const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason)
  if (unresolved.length || errors.length) throw new AggregateError(errors, 'Fixture identity remained unknown; preserved at ' + root)
  await exited.catch(() => {})
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
