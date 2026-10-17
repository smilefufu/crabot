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
const expectedCompletion = mode === 'updater' || mode === 'unreadable'
const { default: identity } = await import(pathToFileURL(path.join(checkout, 'scripts/lib/process-identity.cjs')))
const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-maintenance-fixture-')))
for (const directory of ['scripts', 'data', 'pids', 'crabot-core/dist', 'crabot-admin/dist']) await fs.mkdir(path.join(root, directory), { recursive: true })
const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
const url = file => pathToFileURL(path.join(checkout, file)).href
const prefix = role => `import{writeFileSync}from'node:fs';import identity from ${JSON.stringify(url('scripts/lib/process-identity.cjs'))};writeFileSync(${JSON.stringify(path.join(root, 'pids', role + '.json'))},JSON.stringify(identity.inspectProcess(process.pid)));`
await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}')
await fs.writeFile(path.join(root, 'cli.mjs'), prefix('cli') + `import{stopInstance}from ${JSON.stringify(url('scripts/lib/instance-controller.mjs'))};${mode === 'unreadable' ? "identity.inspectProcessArguments=()=>{throw new Error('unreadable fixture')}" : ''};try{await stopInstance(${JSON.stringify(path.join(root, 'data'))});writeFileSync(${JSON.stringify(path.join(root, 'done'))},'stopped')}catch(error){if(${JSON.stringify(mode)}!=='unreadable'||error.code!=='CRABOT_STOP_UNKNOWN')throw error;writeFileSync(${JSON.stringify(path.join(root, 'done'))},'unknown-before-stop')};`)
await fs.writeFile(path.join(root, 'scripts/ui-upgrade.mjs'), prefix('updater') + `import{spawn}from'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(path.join(root, 'cli.mjs'))},'stop'],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));`)
const updaterArgs = [path.join(root, 'scripts/ui-upgrade.mjs'), ...(mode === 'extra-args' ? ['unexpected'] : [])]
await fs.writeFile(path.join(root, 'crabot-admin/dist/main.js'), prefix('admin') + `import{spawn}from'node:child_process';process.once('message',()=>{const child=spawn(process.execPath,${JSON.stringify(updaterArgs)},{detached:true,stdio:'inherit'});child.unref()});setInterval(()=>{},1000);`)
await fs.writeFile(path.join(root, 'crabot-core/dist/main.js'), prefix('mm') + `
import{spawn}from'node:child_process';import{once}from'node:events';import{createServer}from'node:http';
import{ModuleRuntimeRegistry}from ${JSON.stringify(url('crabot-core/dist/module-runtime-registry.js'))};
const registry=new ModuleRuntimeRegistry(${JSON.stringify(path.join(root, 'data'))});await registry.initialize();
const admin=spawn(process.execPath,[${JSON.stringify(path.join(root, 'crabot-admin/dist/main.js'))}],{stdio:['ignore','inherit','inherit','ipc']});
const runtimeId=registry.createRuntimeId();await registry.recordSpawn({moduleId:${JSON.stringify(mode === 'agent-parent' ? 'core-agent' : 'admin-web')},runtimeId,rootPid:admin.pid,modulePort:23456});
let stopping=false;async function stop(){if(stopping)return;stopping=true;const exited=once(admin,'exit');admin.kill();await exited;await registry.removeRuntime(runtimeId);process.exit(0)}
process.on('SIGTERM',stop);createServer((req,res)=>{if(req.url==='/shutdown'){res.end(JSON.stringify({success:true}));void stop()}else res.end('{}')}).listen(${port},'127.0.0.1',()=>admin.send('start'));
`)
await fs.writeFile(path.join(root, 'controller.mjs'), prefix('controller') + `
import{spawn}from'node:child_process';import{createInstanceRuntime,recordMmProcess}from ${JSON.stringify(url('scripts/lib/instance-runtime.mjs'))};
const data=${JSON.stringify(path.join(root, 'data'))};const record=createInstanceRuntime({dataDir:data,root:${JSON.stringify(root)},mmPort:${port}});
const mm=spawn(process.execPath,[${JSON.stringify(path.join(root, 'crabot-core/dist/main.js'))}],{stdio:'inherit'});recordMmProcess(data,record.generation,mm.pid);
process.on('SIGTERM',()=>mm.kill());mm.on('exit',code=>process.exit(code??1));
`)
const child = spawn(process.execPath, [path.join(root, 'controller.mjs')], { stdio: ['ignore', 'ignore', 'pipe'] })
const exited = once(child, 'exit')
let stderr = ''; child.stderr.on('data', value => { stderr += value })
let passed = false
try {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (await fs.access(path.join(root, 'done')).then(() => true, () => false)) { passed = true; break }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(passed, expectedCompletion, 'Incorrect maintenance ownership; ' + stderr)
  if (mode === 'unreadable') {
    const controller = JSON.parse(await fs.readFile(path.join(root, 'pids/controller.json'), 'utf8'))
    assert.ok(identity.sameProcess(controller, identity.inspectProcess(controller.pid)), 'Unknown argv stopped the controller')
    assert.equal(await fs.readFile(path.join(root, 'done'), 'utf8'), 'unknown-before-stop')
  }
  console.log('CONTROLLED_UI_MAINTENANCE_STOP ' + JSON.stringify({ passed: true, completed: passed, mode, business_mm: false }))
} finally {
  const files = await fs.readdir(path.join(root, 'pids'))
  for (const file of files.reverse()) {
    const expected = JSON.parse(await fs.readFile(path.join(root, 'pids', file), 'utf8'))
    if (identity.sameProcess(expected, identity.inspectProcess(expected.pid))) { try { process.kill(expected.pid, 'SIGKILL') } catch {} }
  }
  await exited.catch(() => {})
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
