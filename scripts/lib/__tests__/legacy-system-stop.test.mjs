import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import identity from '../process-identity.cjs'
import management from '../desktop-management.cjs'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacySystemRelease, discoverFencedLegacySystemRelease } from '../legacy-system-release.mjs'
import { LegacySystemEntryFence } from '../legacy-system-fence.mjs'
import { discoverLegacySystemDeployment } from '../legacy-system-runtime.mjs'
import { stopFencedLegacySystemInstance } from '../legacy-system-stop.mjs'

const options = { skip: process.platform === 'win32', timeout: 20_000 }
async function fixture(t, mode) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-shared-legacy-stop-')))
  const root = path.join(parent, 'code'), data = management.ensurePrivateDataRoot(path.join(parent, 'private-data')), audit = path.join(parent, 'requests')
  await fs.mkdir(root); await fs.mkdir(path.join(data, 'agent')); await fs.mkdir(path.join(root, 'crabot-agent'))
  await fs.writeFile(path.join(data, 'preserved'), 'same employee data')
  await materializeLegacyRelease(root)
  const policy = { platform: 'linux', ownerUid: process.getuid(), checkRoot: () => {} }
  const release = await discoverLegacySystemRelease({ root, ...policy })
  const fence = new LegacySystemEntryFence(policy), operation = randomUUID()
  await fence.fence(release, operation)
  // A controlled HTTP server and its real parent; only argv is substituted.
  // This is neither root ownership evidence nor a business MM/systemd process.
  const server = `const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const[root,data,mode,audit]=process.argv.slice(1);const server=http.createServer(async(req,res)=>{let raw='';for await(const bytes of req)raw+=bytes;const body=JSON.parse(raw);fs.appendFileSync(audit,req.url+'\\n');if(req.url==='/get_module_definition')res.end(JSON.stringify({id:body.id,success:true,data:{definition:{module_id:'crabot-agent',cwd:path.join(root,'crabot-agent'),env:{DATA_DIR:data,CRABOT_AGENT_DATA_DIR:path.join(data,'agent'),CRABOT_PORT_OFFSET:String(server.address().port-19000)}}}}));else if(req.url==='/shutdown'){if(mode==='drop')res.destroy();else res.end(JSON.stringify({id:body.id,success:true,data:{}}));if(mode!=='hold')setTimeout(()=>process.exit(0),30)}});let port=19100;server.on('error',error=>{if(error.code!=='EADDRINUSE'||port>=28900)throw error;port+=100;server.listen(port,'127.0.0.1')});server.once('listening',()=>process.send({port:server.address().port,pid:process.pid}));server.listen(port,'127.0.0.1')`
  const controllerCode = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(server)},...process.argv.slice(1)],{stdio:['ignore','ignore','inherit','ipc']});child.on('message',message=>process.send(message));child.on('exit',code=>process.exit(code??1));process.on('message',()=>child.kill('SIGKILL'))`
  const controller = spawn(process.execPath, ['-e', controllerCode, root, data, mode, audit], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  t.after(async () => {
    if (controller.exitCode === null && controller.signalCode === null) {
      const exit = once(controller, 'exit', { signal: AbortSignal.timeout(10_000) })
      if (controller.connected) controller.send('fixture-cleanup')
      await exit
    }
    await fs.rm(parent, { recursive: true, force: true })
  })
  const [ready] = await once(controller, 'message', { signal: AbortSignal.timeout(10_000) })
  await fs.writeFile(path.join(data, 'mm.pid'), String(controller.pid))
  const inspectArgs = identity.inspectProcessArguments
  t.mock.method(identity, 'listProcessIds', () => [controller.pid, ready.pid])
  t.mock.method(identity, 'inspectProcessArguments', pid => pid === controller.pid ? [process.execPath, path.join(root, 'scripts/supervisor.mjs')]
    : pid === ready.pid ? [process.execPath, path.join(root, 'crabot-core/dist/main.js')] : inspectArgs(pid))
  const context = { release, port_offset_hint: ready.port - 19000 }
  const originalManifest = 'a'.repeat(64)
  const observation = { uid: process.getuid(), user: userInfo().username, install_root: root, port_offset: context.port_offset_hint,
    code_fingerprint: release.code_fingerprint, manifest_fingerprint: originalManifest, data_binding: 'unverified' }
  const runtimeOptions = { observeAccount: async () => {
    assert.deepEqual(await discoverFencedLegacySystemRelease({ root, ...policy }), release)
    return observation
  } }
  const expected = await discoverLegacySystemDeployment(context, runtimeOptions)
  const requests = async () => (await fs.readFile(audit, 'utf8')).trim().split('\n')
  const stop = extra => stopFencedLegacySystemInstance(context, { expected, timeoutMs: 5000, runtimeOptions, ...extra })
  return { root, data, controller, expected, observation, stop, requests }
}

for (const mode of ['ack', 'drop']) test('system legacy stop sends shutdown once and proves the owned original tree exited: ' + mode, options, async t => {
  const f = await fixture(t, mode)
  assert.deepEqual(await f.stop(), { state: 'stopped', request_acknowledged: mode === 'ack' })
  assert.equal((await f.requests()).filter(value => value === '/shutdown').length, 1)
  assert.equal(await fs.readFile(path.join(f.data, 'preserved'), 'utf8'), 'same employee data')
  assert.equal(await fs.readFile(path.join(f.data, 'mm.pid'), 'utf8'), String(f.controller.pid), 'do not erase old evidence as proof of shutdown')
})

test('an acknowledged but surviving shared legacy server stays unknown without force or automatic replay', options, async t => {
  const f = await fixture(t, 'hold')
  await assert.rejects(f.stop({ timeoutMs: 150 }), { code: 'CRABOT_LEGACY_STOP_UNKNOWN' })
  assert.equal(f.controller.exitCode, null)
  assert.equal((await f.requests()).filter(value => value === '/shutdown').length, 1)
})

for (const changed of ['manifest', 'generation', 'code', 'invalid-timeout']) test('system legacy stop refuses changed evidence before any shutdown: ' + changed, options, async t => {
  const f = await fixture(t, 'hold')
  if (changed === 'manifest') f.observation.manifest_fingerprint = 'b'.repeat(64)
  if (changed === 'generation') f.expected.mm = { ...f.expected.mm, started: 'stale' }
  if (changed === 'code') await fs.appendFile(path.join(f.root, 'crabot-core/dist/index.js'), 'custom code')
  await assert.rejects(f.stop(changed === 'invalid-timeout' ? { timeoutMs: 0 } : undefined))
  assert.equal((await f.requests()).includes('/shutdown'), false)
  assert.equal(f.controller.exitCode, null)
})
