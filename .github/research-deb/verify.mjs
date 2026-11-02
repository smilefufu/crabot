// Standard DEB feasibility only, in an expendable GitHub Ubuntu VM.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0)
const exec = promisify(execFile), base = path.resolve('.desktop-build/appimage-research')
const root = '/opt/CrabotResearch', core = root + '/resources/core', entry = root + '/crabot-desktop'
const data = path.join(base, 'deb-data'), home = path.join(base, 'deb-home')
const env = { ...process.env, DATA_DIR: data, HOME: home, XDG_CONFIG_HOME: home + '/config', XDG_CACHE_HOME: home + '/cache', XDG_DATA_HOME: home + '/share' }
for (const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','CRABOT_DEV','CRABOT_PORT_OFFSET']) delete env[key]
await fs.mkdir(data, { recursive: true }); await fs.mkdir(home, { recursive: true })
const report = { research_only: true, environment: 'Ubuntu24 GitHub VM Xvfb; no GNOME human acceptance',
  upgrade_fixture: 'same source, two version stamps .1 to .2; not real released cross-version migration', checks: [] }
const children = [], pause = ms => new Promise(r => setTimeout(r, ms))
const restriction = (await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns','utf8')).trim()
assert.equal(restriction, '1')
async function command(file, args, options = {}) { return (await exec(file,args,{timeout:180000,maxBuffer:2000000,...options})).stdout }
const cli = (...args) => command(core + '/.product-runtime/node/bin/node',[core + '/cli.mjs',...args],{env,timeout:90000})
async function install(version) {
  const file = path.join(base,'deb-output','crabot-research-' + version + '.deb')
  const output = await command('/usr/bin/sudo',['-n','/usr/bin/apt-get','install','-y',file])
  const actual = (await command('/usr/bin/dpkg-query',['-W','-f=${Version}','crabot-research'])).trim()
  assert.equal(actual, version.replace('-', '~'))
  report.checks.push({name:'standard_dpkg_install_' + version,version:actual,bytes:(await fs.stat(file)).size,output})
}
async function launch(label) {
  const child = spawn(entry,[],{env,stdio:['ignore','pipe','pipe']}); children.push(child)
  let output = ''; const phases = []
  function consume(bytes) { output = (output + bytes).slice(-100000); for (const line of output.split('\n')) {
    try { const v=JSON.parse(line); if(v.component==='desktop' && !phases.some(x=>x.at===v.at&&x.phase===v.phase)) phases.push(v) } catch {}
  } }
  child.stdout.on('data',consume); child.stderr.on('data',consume)
  const deadline=Date.now()+180000
  while(!phases.some(p=>['ready','error','migration_required'].includes(p.phase)) && child.exitCode===null && child.signalCode===null && Date.now()<deadline) await pause(100)
  const ready=phases.some(p=>p.phase==='ready')
  report.checks.push({name:label,ready,phases,output:output.slice(-18000)})
  assert.ok(ready,label+' failed: '+output.slice(-4000))
  return child
}
async function killGui(child) { if(child.exitCode===null && child.signalCode===null) { child.kill('SIGKILL'); await Promise.race([once(child,'close'),pause(5000)]) } }
try {
  await install('0.1.0-desktop.1')
  const menu=await fs.readFile('/usr/share/applications/crabot-desktop.desktop','utf8')
  assert.match(menu,/Exec=.*\/opt\/CrabotResearch\/crabot-desktop/)
  report.checks.push({name:'standard_menu_fixed_path',menu,program_owner:(await fs.stat(entry)).uid,
    profile:await fs.readFile('/etc/apparmor.d/crabot-desktop','utf8')})
  let gui=await launch('first_install_ordinary_gui')
  report.checks.push({name:'gui_kernel_sandbox',observation:JSON.parse(await command('/usr/bin/sudo',['-n','/usr/bin/python3',path.resolve('.github/research-appimage/kernel.py'),String(gui.pid),String(process.getuid())]))})
  const server=createServer((req,res)=> { if(req.method==='POST'){res.end('ok');return} res.setHeader('Content-Type','text/html');res.end('<title>Crabot</title><body>Crabot<script>fetch(location.href,{method:"POST"}).then(()=>document.body.dataset.ready="yes")</script>') })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  try {
    const runtime=JSON.parse(await fs.readFile(core+'/product-runtime.json','utf8'))
    for(const guarded of [false,true]) {
      const output=await command(core+'/'+runtime.executables.python,['-I','-B',path.resolve('.github/research-appimage/browser.py'),core,'http://127.0.0.1:'+server.address().port,...(guarded?['--managed-guard']:[])],{env,timeout:150000})
      const kernels=output.split('\n').filter(x=>x.startsWith('CRABOT_RESEARCH_BROWSER_KERNEL=')).map(x=>JSON.parse(x.slice('CRABOT_RESEARCH_BROWSER_KERNEL='.length)))
      report.checks.push({name:guarded?'existing_guard_explicit_component_positive_control':'unchanged_product_browser_component',existing_guard_explicitly_enabled_by_research:guarded,kernels,output})
    }
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  let status=JSON.parse(await cli('status','--json')); assert.equal(status.running,true)
  const before=JSON.parse(await fs.readFile(data+'/instance-runtime.json','utf8'))
  report.checks.push({name:'first_core',status})
  const secret=randomBytes(32); await fs.writeFile(data+'/research-secret',secret,{mode:0o600})
  const hash=createHash('sha256').update(secret).digest('hex')
  await killGui(gui); await pause(3000)
  status=JSON.parse(await cli('status','--json')); assert.equal(status.running,true)
  const after=JSON.parse(await fs.readFile(data+'/instance-runtime.json','utf8'))
  assert.equal(after.mm.pid,before.mm.pid)
  report.checks.push({name:'gui_crash_core_and_program_survive',running:status.running,same_mm:after.mm.pid===before.mm.pid,entry_available:!!(await fs.stat(core+'/cli.mjs'))})
  gui=await launch('same_install_ordinary_reopen')
  report.checks.push({name:'cli_stop_before_upgrade',output:await cli('stop')})
  assert.equal(JSON.parse(await cli('status','--json')).running,false)
  await killGui(gui)
  await install('0.1.0-desktop.2')
  gui=await launch('standard_overwrite_upgrade_gui')
  const version=JSON.parse(await fs.readFile(core+'/package.json','utf8')).version
  const tools=path.join(base,'tools/package.json')
  const {createRequire}=await import('node:module');const req=createRequire(tools)
  const guiVersion=JSON.parse(req('@electron/asar').extractFile(root+'/resources/app.asar','package.json').toString()).version
  assert.equal(version,'0.1.0-desktop.2');assert.equal(guiVersion,version)
  assert.equal(createHash('sha256').update(await fs.readFile(data+'/research-secret')).digest('hex'),hash)
  report.checks.push({name:'upgrade_new_gui_core_and_data_retained',core_version:version,gui_version:guiVersion,synthetic_secret_retained:true,status:JSON.parse(await cli('status','--json'))})
  report.checks.push({name:'final_clean_stop',output:await cli('stop')})
  assert.equal(JSON.parse(await cli('status','--json')).running,false)
  await killGui(gui)
  await command('/usr/bin/sudo',['-n','/usr/bin/dpkg','-r','crabot-research'])
  let removed=false;try{await fs.stat(entry)}catch(e){if(e.code==='ENOENT')removed=true;else throw e}
  assert.equal(removed,true);assert.equal(createHash('sha256').update(await fs.readFile(data+'/research-secret')).digest('hex'),hash)
  report.checks.push({name:'standard_uninstall_retains_external_data',program_removed:removed,data_retained:true})
} catch(error) {report.failure={message:error.message,code:error.code,stdout:error.stdout,stderr:error.stderr};process.exitCode=1}
finally {
  try{await cli('stop')}catch{}
  for(const child of children)await killGui(child)
  assert.equal((await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns','utf8')).trim(),restriction)
  await fs.writeFile(path.join(base,'deb-report.json'),JSON.stringify(report,null,2)+'\n')
  console.log('CRABOT_DEB_REPORT '+JSON.stringify(report))
}
