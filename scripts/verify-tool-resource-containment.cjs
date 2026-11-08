// Zero-model acceptance. Run only in the dedicated 2 CPU / 4 GiB delegated Linux profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = process.env.CRABOT_TOOL_CGROUP_ROOT
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-resource-acceptance-'))
process.env.DATA_DIR = temp
const { runHostProcess } = require('../crabot-agent/dist/engine/host-process.js')
const { readExecutionResources } = require('../crabot-agent/dist/engine/tool-resources.js')
const { runShellWithGrace } = require('../crabot-agent/dist/engine/bg-entities/bg-shell.js')
const { BgEntityRegistry } = require('../crabot-agent/dist/engine/bg-entities/registry.js')
const { localHostToolExecutor } = require('../crabot-agent/dist/engine/local-host-tool-executor.js')
const { stopResourceScope } = require('../crabot-agent/dist/engine/tool-resource-scope.js')
const results = []
const startPid = process.pid
const control = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8').trim()
const node = (program, timeout = 45000) => runHostProcess({ argv: [process.execPath, '-e', program],
  limits: { timeoutMs: timeout, stdoutBytes: 65536, stderrBytes: 65536 } })
async function check(name, test) { const result = await test(); results.push({ name, result }); console.log(JSON.stringify(results.at(-1))) }
const hog = `const b=[]; function grow(){for(let i=0;i<4;i++) b.push(Buffer.alloc(16*1024*1024, 1)); setImmediate(grow)}; grow()`
async function main() {
  assert.equal(process.platform, 'linux'); assert(root)
  assert.equal(control(path.dirname(root), 'memory.max'), '4294967296')
  assert.equal(control(root, 'memory.max'), '2952790016'); assert.equal(control(root, 'pids.max'), '512')
  const budget = readExecutionResources()
  assert.equal(budget.protection, 'cgroup_v2'); assert.equal(budget.effective.cpu_count, 2)
  await check('tool identity cannot change aggregate caps or enter controller branch', async () => {
    const result = await node(`const f=require('fs');let denied=0;for(const [p,v] of [['/cg/tools/memory.max','2952790016'],['/cg/tools/pids.max','512'],['/cg/control/cgroup.procs',String(process.pid)]]){try{f.writeFileSync(p,v)}catch(e){if(e.code==='EACCES'||e.code==='EPERM')denied++}}try{f.mkdirSync('/cg/escape')}catch(e){if(e.code==='EACCES'||e.code==='EPERM')denied++}console.log(denied)`)
    assert.equal(result.stdout.trim(),'4'); assert.equal(result.exitCode,0)
    return { uid: process.getuid(), denied: 4, resources: result.resources }
  })
  await check('file helper protocol remains usable inside the resource boundary', async () => {
    const file = path.join(temp, 'helper.txt')
    for (const [op, input] of [['write',{file_path:file,content:'one'}],['read',{file_path:file}],['edit',{file_path:file,old_string:'one',new_string:'two'}]]) {
      const result = await localHostToolExecutor.execute(op,input,temp,{})
      assert.equal(result.result.isError,false,JSON.stringify(result))
    }
    assert.equal(fs.readFileSync(file,'utf8'),'two'); return { write: true, read: true, edit: true }
  })
  await check('pytest auto uses two workers', async () => {
    const info = await runHostProcess({ argv: ['python3','-c','import os,json; print(json.dumps({"visible_cpus":os.cpu_count(),"auto_env":os.environ.get("PYTEST_XDIST_AUTO_NUM_WORKERS")}))'], limits:{timeoutMs:5000,stdoutBytes:4096,stderrBytes:4096} })
    const python = JSON.parse(info.stdout); assert.equal(python.auto_env,'2')
    const tests = path.join(temp, 'test_auto.py')
    fs.writeFileSync(tests, `import os, time\nimport pytest\n@pytest.mark.parametrize('i', range(16))\ndef test_budget(i, worker_id):\n    open(os.path.join(${JSON.stringify(temp)}, worker_id), 'a').write('x')\n    time.sleep(.02)\n`)
    const result = await runHostProcess({ argv: ['python3', '-m', 'pytest', '-n', 'auto', '-v', tests], cwd: temp,
      limits: { timeoutMs: 45000, stdoutBytes: 65536, stderrBytes: 65536 } })
    assert.equal(result.kind, 'exit', JSON.stringify(result)); assert.equal(result.exitCode, 0, result.stderr)
    assert.match(result.stdout,/2 workers \[16 items\]/)
    assert.deepEqual(fs.readdirSync(temp).filter(f => /^gw\d+$/.test(f)).sort(), ['gw0', 'gw1'])
    return { budget, python, workers: ['gw0', 'gw1'], pytest_stdout: result.stdout }
  })
  await check('memory exhaustion preserves side effect and Agent', async () => {
    const marker = path.join(temp, 'side-effect')
    const result = await node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'once'); ${hog}`)
    assert.equal(result.kind, 'resource_limit', JSON.stringify(result)); assert.equal(result.resources.cleanup, 'complete')
    assert(result.resources.memory_events.oom_kill > 0); assert.equal(fs.readFileSync(marker, 'utf8'), 'once')
    assert.equal(process.pid, startPid)
    assert.equal((await node("console.log('Agent still works')")).stdout.trim(), 'Agent still works')
    return result
  })
  await check('concurrent commands share one memory budget', async () => {
    const hold = `const b=[]; for(let i=0;i<110;i++)b.push(Buffer.alloc(16*1024*1024,1));setInterval(()=>{},1000)`
    const pair = await Promise.all([node(hold), node(hold)])
    pair.forEach(r => { assert.equal(r.kind, 'resource_limit', JSON.stringify(r)); assert.equal(r.resources.cleanup, 'complete') })
    return pair
  })
  await check('setsid descendant remains inside memory boundary', async () => {
    const result = await node(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(hog)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`)
    assert.equal(result.kind, 'resource_limit', JSON.stringify(result)); assert.equal(result.resources.cleanup, 'complete')
    return result
  })
  await check('task exhaustion is reported even after zero exit', async () => {
    const result = await node(`const kids=[];let errors=0;for(let i=0;i<600;i++){const c=require('child_process').spawn('/bin/sleep',['10'],{stdio:'ignore'});c.on('error',()=>errors++);kids.push(c)}setTimeout(()=>{for(const c of kids)c.kill();console.log(errors)},500)`)
    assert.equal(result.kind, 'resource_limit', JSON.stringify(result)); assert(result.resources.pids_events.max > 0)
    assert.equal(result.resources.cleanup, 'complete'); return result
  })
  await check('background promotion and whole-group cancellation', async () => {
    const registry = new BgEntityRegistry(path.join(temp, 'bg.json'))
    const notify = []
    const result = await runShellWithGrace({ command: `node -e 'setInterval(()=>{},1000)'`, cwd: temp, registry,
      owner: { friend_id: 'validation', worker_id: 'validation' }, spawned_by_task_id: 'validation', gracePeriodMs: 20, onShellExit: i => notify.push(i) })
    assert.equal(result.kind, 'background')
    const record = await registry.get(result.entity_id); assert(record.resource_scope)
    const stopped = await stopResourceScope(record.resource_scope); assert.equal(stopped.cleanup, 'complete')
    for(let i=0;i<100 && notify.length===0;i++) await new Promise(r=>setTimeout(r,20))
    assert.equal(notify.length,1)
    const final = await registry.get(result.entity_id)
    assert.equal(final.resource_result.cleanup, 'complete'); assert.equal(final.status, 'failed')
    return { scope: record.resource_scope, terminal: final.status, notifications: notify.length, resource_result: final.resource_result }
  })
  await check('Agent restart stops protected orphan without replay', async () => {
    const registryPath = path.join(temp, 'restart.json')
    const program = `process.env.DATA_DIR=${JSON.stringify(temp)}; const {BgEntityRegistry}=require(${JSON.stringify(require.resolve('../crabot-agent/dist/engine/bg-entities/registry.js'))}); const {spawnPersistentShell}=require(${JSON.stringify(require.resolve('../crabot-agent/dist/engine/bg-entities/bg-shell.js'))}); spawnPersistentShell({command:'sleep 60',cwd:${JSON.stringify(temp)},registry:new BgEntityRegistry(${JSON.stringify(registryPath)}),owner:{friend_id:'validation',worker_id:'validation'},spawned_by_task_id:'validation'}).then(()=>process.exit(0))`
    await new Promise((resolve,reject)=>{const c=spawn(process.execPath,['-e',program],{stdio:'inherit'});c.once('error',reject);c.once('exit',code=>code===0?resolve():reject(new Error('producer failed')))})
    const recovered = await new BgEntityRegistry(registryPath).recoverPersistent()
    assert.equal(recovered.alive.length,0); assert.equal(recovered.deadShells.length,1)
    assert.equal(recovered.deadShells[0].resource_result.cleanup,'complete')
    return { status: recovered.deadShells[0].status, resource_result: recovered.deadShells[0].resource_result }
  })
  assert.equal(process.pid, startPid)
  assert.equal(control(root, 'cgroup.events').includes('populated 0'),true)
  assert.equal(fs.readdirSync(root, {withFileTypes:true}).filter(e=>e.isDirectory()).length,0)
  console.log(JSON.stringify({ passed: true, agent_pid: startPid, results }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
