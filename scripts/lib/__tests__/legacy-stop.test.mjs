import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import identity from '../process-identity.cjs'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacyUserInstall } from '../legacy-desktop.mjs'
import { fenceLegacyEntries, inspectLegacyEntryFence } from '../legacy-entry-fence.mjs'
import { stopFencedLegacyInstance } from '../legacy-stop.mjs'

async function fixture(t, mode) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot legacy stop ')))
  const root = path.join(parent, 'root'), data = path.join(parent, 'data'), audit = path.join(parent, 'requests')
  await fs.mkdir(root); await fs.mkdir(data); await fs.mkdir(path.join(data, 'agent')); await fs.mkdir(path.join(root, 'crabot-agent'))
  await fs.writeFile(path.join(data, 'keep'), 'preserved')
  await materializeLegacyRelease(root)
  const installation = await discoverLegacyUserInstall({ root, dataDir: data })
  const entryFenceId = (await fenceLegacyEntries(installation)).id
  // A disposable protocol server and its real parent, not a business MM. Only
  // their argv is substituted; OS identities, parent link, TCP and HTTP are real.
  const server = `const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const[root,data,mode,audit]=process.argv.slice(1);const server=http.createServer(async(req,res)=>{let text='';for await(const bytes of req)text+=bytes;const body=JSON.parse(text);fs.appendFileSync(audit,req.url+'\\n');if(req.url==='/get_module_definition')res.end(JSON.stringify({id:body.id,success:true,data:{definition:{module_id:'crabot-agent',cwd:path.join(root,'crabot-agent'),env:{DATA_DIR:data,CRABOT_AGENT_DATA_DIR:path.join(data,'agent')}}}}));else if(req.url==='/shutdown'){if(mode==='drop')res.destroy();else res.end(JSON.stringify({id:body.id,success:true,data:{}}));if(mode!=='hold')setTimeout(()=>process.exit(0),30)}});server.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:server.address().port}))`
  const controllerCode = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(server)},...process.argv.slice(1)],{stdio:['ignore','ignore','inherit','ipc']});child.on('message',value=>process.send(value));child.on('exit',code=>process.exit(code??1));process.on('message',()=>child.kill('SIGKILL'))`
  const controller = spawn(process.execPath, ['-e', controllerCode, root, data, mode, audit], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  t.after(async () => {
    if (controller.exitCode === null && controller.signalCode === null) {
      const exited = once(controller, 'exit', { signal: AbortSignal.timeout(10_000) })
      if (controller.connected) controller.send('fixture-cleanup')
      await exited
    }
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const [ready] = await once(controller, 'message', { signal: AbortSignal.timeout(10_000) })
  await fs.writeFile(path.join(data, 'mm.pid'), String(controller.pid))
  const originalArgs = identity.inspectProcessArguments
  t.mock.method(identity, 'listProcessIds', () => [controller.pid, ready.pid])
  t.mock.method(identity, 'inspectProcessArguments', pid => pid === controller.pid ? [process.execPath, path.join(root, 'scripts/supervisor.mjs')]
    : pid === ready.pid ? [process.execPath, path.join(root, 'crabot-core/dist/main.js')] : originalArgs(pid))
  return { root, data, audit, controller, installation, entryFenceId }
}

for (const mode of ['ack', 'drop']) test('fenced legacy shutdown observes actual exit with ' + mode + ' reply', { timeout: 20_000 }, async t => {
  const f = await fixture(t, mode)
  const result = await stopFencedLegacyInstance(f.installation, { entryFenceId: f.entryFenceId, timeoutMs: 5000 })
  assert.deepEqual(result, { state: 'stopped', request_acknowledged: mode === 'ack' })
  assert.deepEqual((await fs.readFile(f.audit, 'utf8')).trim().split('\n'), ['/get_module_definition', '/shutdown'])
  assert.equal((await inspectLegacyEntryFence(f.root)).entries_fenced, true)
  assert.equal(await fs.readFile(path.join(f.data, 'keep'), 'utf8'), 'preserved')
})

test('an acknowledged shutdown with surviving processes remains unknown without force or replay', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'hold')
  await assert.rejects(stopFencedLegacyInstance(f.installation, { entryFenceId: f.entryFenceId, timeoutMs: 150 }), { code: 'CRABOT_LEGACY_STOP_UNKNOWN' })
  assert.equal(f.controller.exitCode, null)
  assert.deepEqual((await fs.readFile(f.audit, 'utf8')).trim().split('\n'), ['/get_module_definition', '/shutdown'])
  assert.equal((await inspectLegacyEntryFence(f.root)).entries_fenced, true)
  assert.equal(await fs.readFile(path.join(f.data, 'keep'), 'utf8'), 'preserved')
})
