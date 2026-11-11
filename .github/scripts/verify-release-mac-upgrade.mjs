// Exact published DMG -> new final DMG at one fixed App path, synthetic data only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { once } from 'node:events'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'darwin')
const run = promisify(execFile), base = path.join(process.env.RUNNER_TEMP, 'exact-desktop-upgrade')
const app = path.join(base, 'Applications/Crabot.app'), data = path.join(base, 'data')
const core = path.join(app, 'Contents/Resources/core'), node = path.join(core, '.product-runtime/node/bin/node')
const executable = path.join(app, 'Contents/MacOS/Crabot'), env = { ...process.env, DATA_DIR: data }
for (const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','CRABOT_DEV','CRABOT_PORT_OFFSET']) delete env[key]
const report = { from: '0.1.0-desktop.25', to: '0.1.0-desktop.26', checks: [] }
let gui, bindingFile
async function replaceApp(dmg) {
  const mount = path.join(base, 'mount'); await fs.mkdir(mount, { recursive: true })
  await run('hdiutil', ['attach','-readonly','-nobrowse','-mountpoint',mount,path.resolve(dmg)], { timeout: 90000 })
  try { await fs.rm(app, { recursive: true, force: true }); await fs.mkdir(path.dirname(app), { recursive: true }); await run('ditto',[path.join(mount,'Crabot.app'),app],{timeout:180000}) }
  finally { await run('hdiutil',['detach',mount],{timeout:60000}) }
}
async function cli(...args) { return (await run(node,[path.join(core,'cli.mjs'),...args],{env,cwd:core,timeout:90000,maxBuffer:2000000})).stdout }
async function boot(version) {
  const child = spawn(executable, ['--background'], { env, stdio: ['ignore','pipe','pipe'] }); gui = child
  let output = ''; const events = []; let buffered = ''
  child.stdout.on('data', bytes => {
    output += bytes; buffered += bytes
    let end
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0,end); buffered = buffered.slice(end+1)
      try { events.push(JSON.parse(line)) } catch {}
    }
  }); child.stderr.on('data', bytes => { output += bytes })
  try {
    const deadline = Date.now()+180000
    while (Date.now()<deadline) {
      assert.equal(child.exitCode,null,output)
      assert.ok(!events.some(e=>e.component==='desktop'&&['error','migration_required'].includes(e.phase)),output)
      if (events.some(e=>e.component==='desktop'&&e.phase==='ready')) break
      await new Promise(resolve=>setTimeout(resolve,200))
    }
    assert.ok(events.some(e=>e.component==='desktop'&&e.phase==='ready'),output)
    assert.ok(events.some(e=>e.component==='desktop-bootstrap'&&e.phase==='app-ready'&&e.app_version===version),output)
    assert.equal((await cli('--version')).trim(),version)
    let status; const readyDeadline=Date.now()+120000
    do {
      status=JSON.parse(await cli('status','--json'))
      if(status.running&&status.modules.filter(m=>['admin-web','crabot-agent','memory-default'].includes(m.module_id)&&m.status==='running').length===3)break
      await new Promise(resolve=>setTimeout(resolve,500))
    }while(Date.now()<readyDeadline)
    assert.equal(status.running,true); assert.equal(status.data_dir,data)
    assert.equal(status.modules.filter(m=>['admin-web','crabot-agent','memory-default'].includes(m.module_id)&&m.status==='running').length,3)
    report.checks.push({ version, app_ready: true, cli_same_version: true, modules_running: true })
  } finally { await fs.writeFile(path.join(base,version+'.log'),output) }
}
async function stop() {
  await cli('stop'); assert.equal(JSON.parse(await cli('status','--json')).running,false)
  if(gui&&gui.exitCode===null&&gui.signalCode===null){const exited=once(gui,'exit');gui.kill('SIGTERM');await exited}
  gui=undefined
}
try {
  await fs.mkdir(base,{recursive:true}); await replaceApp(process.argv[2])
  const moduleAt = name => import(pathToFileURL(path.join(core,'scripts/lib',name)).href)
  const management = (await moduleAt('desktop-management.cjs')).default
  const binding = (await moduleAt('mac-app-binding.cjs')).default
  assert.equal(binding.readMacAppBinding(),null)
  management.ensurePrivateDataRoot(data); management.initializeDesktopManagement(data)
  binding.writeMacAppBinding({appPath:app,dataDir:data}); bindingFile=binding.bindingFile(homedir())
  await boot(report.from)
  const sentinel=path.join(data,'release-upgrade-sentinel');await fs.writeFile(sentinel,'preserve exact old desktop data')
  await run(node,['--input-type=module','-e',`import{pathToFileURL}from'node:url';const m=await import(pathToFileURL(process.argv[1]));await m.createCredentialsIfAbsent(process.argv[2],await m.newCredentialsFromPassword('synthetic-upgrade-only',{is_temp:false,changed_via:'start'}))`,path.join(core,'crabot-admin/dist/credentials.js'),path.join(data,'admin')],{env,timeout:30000})
  const credentials=path.join(data,'admin/credentials.json'), before=await fs.readFile(credentials)
  await stop(); await replaceApp(process.argv[3]); await boot(report.to)
  assert.equal(await fs.readFile(sentinel,'utf8'),'preserve exact old desktop data')
  assert.deepEqual(await fs.readFile(credentials),before)
  await stop(); await boot(report.to); await stop()
  report.fixed_app_path=true;report.original_data_preserved=true;report.reopened_new_version=true
} catch(error) { report.failure={message:error.message,stack:error.stack};process.exitCode=1 }
finally {
  try{if(gui)await stop()}catch{}
  if(bindingFile)await fs.rm(bindingFile,{force:true})
  await fs.writeFile(path.join(base,'acceptance.json'),JSON.stringify(report,null,2)+'\n')
  console.log('CRABOT_RELEASE_UPGRADE '+JSON.stringify(report))
}
