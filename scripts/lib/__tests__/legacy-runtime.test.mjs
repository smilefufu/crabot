import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import identity from '../process-identity.cjs'
import { discoverLegacyUserInstall } from '../legacy-desktop.mjs'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { fenceLegacyEntries } from '../legacy-entry-fence.mjs'
import { discoverLegacyRuntime, withVerifiedLegacyRuntime } from '../legacy-runtime.mjs'

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'crabot-legacy-runtime-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = path.join(parent, 'old'), data = path.join(parent, 'custom-data')
  await fs.mkdir(root); await fs.mkdir(data); await fs.mkdir(path.join(data, 'agent')); await fs.mkdir(path.join(root, 'crabot-agent'))
  await materializeLegacyRelease(root)
  return { parent, root, data, installation: await discoverLegacyUserInstall({ root, dataDir: data }) }
}

test('real old entry hashes plus no launcher or module records establish a stopped discovery only', async t => {
  const f = await fixture(t)
  t.mock.method(identity, 'listProcessIds', () => [])
  assert.equal((await discoverLegacyRuntime(f.installation)).state, 'stopped')
  await fs.mkdir(path.join(f.data, 'module-runtime-registry/records'), { recursive: true })
  await fs.writeFile(path.join(f.data, 'module-runtime-registry/records/unsettled.json'), '{}')
  await assert.rejects(discoverLegacyRuntime(f.installation), /运行记录尚未收口/)
  assert.equal(await fs.readFile(path.join(f.root, 'VERSION'), 'utf8'), 'v2026.10.15.1\n')
})

test('a copied PID file does not adopt or signal the process it names', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  t.mock.method(identity, 'listProcessIds', () => [])
  await assert.rejects(discoverLegacyRuntime(f.installation), /PID 不属于/)
  assert.equal(await fs.readFile(path.join(f.data, 'mm.pid'), 'utf8'), String(process.pid))
})

for (const [kind, correctData] of [['daemon', true], ['daemon-observer-delay', true], ['daemon-fenced', true], ['daemon', false], ['foreground-cli', true], ['foreground-script', true], ['foreground-cli-invalid', true]]) test('controlled legacy runtime binds its actual launch form and DataRoot: ' + kind + '/' + correctData, { timeout: 20_000 }, async t => {
  const f = await fixture(t), requests = []
  const entryFenceId = kind === 'daemon-fenced' ? (await fenceLegacyEntries(f.installation)).id : undefined
  const actualData = correctData ? f.data : path.join(f.parent, 'another-instance')
  if (!correctData) { await fs.mkdir(actualData); await fs.mkdir(path.join(actualData, 'agent')) }
  // HTTP completion and IPC audit delivery are separate OS channels. The fake
  // server waits until this test has observed the request before replying.
  const source = `const http=require('node:http'),path=require('node:path');const server=http.createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const body=JSON.parse(text);await new Promise(resolve=>{process.once('message',reply=>{if(reply.ack!==body.id)throw new Error('fixture audit acknowledgement mismatch');resolve()});process.send({request:req.url,id:body.id})});res.end(JSON.stringify({id:body.id,success:true,data:{definition:{module_id:'crabot-agent',cwd:path.join(process.argv[2],'crabot-agent'),env:{DATA_DIR:process.argv[1],CRABOT_AGENT_DATA_DIR:path.join(process.argv[1],'agent')}}}}))});server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}))`
  const child = spawn(process.execPath, ['-e', source, actualData, f.root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  child.on('message', message => {
    if (!message.request) return
    const observed = () => { requests.push(message.request); child.send({ ack: message.id }) }
    if (kind === 'daemon-observer-delay') setTimeout(observed, 100); else observed()
  })
  t.after(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exit = once(child, 'exit'); child.kill(); await exit })
  await once(child, 'message')
  // Only argv is substituted. PID/start/owner/parent/executable, TCP listener and
  // HTTP connection are real OS evidence. No full business MM runs on this host.
  t.mock.method(identity, 'listProcessIds', () => [process.pid, child.pid])
  t.mock.method(identity, 'inspectProcessArguments', pid => pid !== process.pid ? [process.execPath, path.join(f.root, 'crabot-core/dist/main.js')]
    : kind.startsWith('foreground-cli') ? [process.execPath, path.join(f.root, 'cli.mjs'), 'start', ...(kind.endsWith('invalid') ? ['--unknown-launch'] : [])]
    : [process.execPath, path.join(f.root, kind.startsWith('daemon') ? 'scripts/supervisor.mjs' : 'scripts/start.mjs')])
  await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  if (kind.endsWith('invalid')) {
    await assert.rejects(discoverLegacyRuntime(f.installation), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' })
    assert.deepEqual(requests, [])
  } else if (correctData) {
    const state = await withVerifiedLegacyRuntime(f.installation, async (snapshot, rpc) => {
      assert.equal(snapshot.state, 'running'); assert.equal(snapshot.mm.pid, child.pid)
      await rpc.shutdown(); return snapshot
    }, { entryFenceId })
    assert.equal(state.launch_kind, kind.startsWith('daemon') ? 'daemon' : 'foreground')
    assert.deepEqual(requests, ['/get_module_definition', '/shutdown'])
  } else {
    await assert.rejects(discoverLegacyRuntime(f.installation), /实际数据目录/)
    assert.deepEqual(requests, ['/get_module_definition'])
  }
  assert.equal(await fs.readFile(path.join(f.data, 'mm.pid'), 'utf8'), String(process.pid))
})

test('a fenced entry proof does not admit later modifications to another critical old module', async t => {
  const f = await fixture(t), record = await fenceLegacyEntries(f.installation)
  await fs.appendFile(path.join(f.root, 'crabot-core/dist/index.js'), '\n// unknown code change\n')
  t.mock.method(identity, 'listProcessIds', () => { assert.fail('Modified source must be rejected before runtime/RPC discovery') })
  await assert.rejects(discoverLegacyRuntime(f.installation, { entryFenceId: record.id }), { code: 'CRABOT_LEGACY_ENTRY_FENCE' })
})

test('an in-flight old CLI management command is never mistaken for a stopped installation', async t => {
  const f = await fixture(t)
  t.mock.method(identity, 'listProcessIds', () => [process.pid])
  t.mock.method(identity, 'inspectProcessArguments', () => [process.execPath, path.join(f.root, 'cli.mjs'), 'upgrade'])
  await assert.rejects(discoverLegacyRuntime(f.installation), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' })
})


test('Linux relative legacy argv is resolved against each actual target cwd, not the new observer cwd', { skip: process.platform !== 'linux', timeout: 20_000 }, async t => {
  const f = await fixture(t), requests = []
  const server = `const http=require('node:http'),path=require('node:path');const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);process.send({request:req.url});res.end(JSON.stringify({id:body.id,success:true,data:{definition:{module_id:'crabot-agent',cwd:path.join(process.argv[2],'crabot-agent'),env:{DATA_DIR:process.argv[1],CRABOT_AGENT_DATA_DIR:path.join(process.argv[1],'agent')}}}}))});server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}))`
  const controllerCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(server)},process.argv[1],process.argv[2]],{cwd:process.cwd(),stdio:['ignore','ignore','inherit','ipc']});child.on('message',message=>process.send({...message,mm_pid:child.pid}));process.on('SIGTERM',()=>{child.once('exit',()=>process.exit(0));child.kill('SIGTERM')})`
  const controller = spawn(process.execPath, ['-e', controllerCode, f.data, f.root], { cwd: f.root, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  t.after(async () => { if (controller.exitCode !== null || controller.signalCode !== null) return; const exited = once(controller, 'exit'); controller.kill('SIGTERM'); await exited })
  const [ready] = await once(controller, 'message')
  controller.on('message', message => { if (message.request) requests.push(message.request) })
  t.mock.method(identity, 'listProcessIds', () => [controller.pid, ready.mm_pid])
  t.mock.method(identity, 'inspectProcessArguments', pid => pid === controller.pid
    ? [process.execPath, 'cli.mjs', 'start'] : [process.execPath, 'crabot-core/dist/main.js'])
  await fs.writeFile(path.join(f.data, 'mm.pid'), String(controller.pid))
  assert.notEqual(process.cwd(), f.root)
  const requested = once(controller, 'message')
  const observed = await discoverLegacyRuntime(f.installation)
  await requested
  assert.equal(observed.controller.pid, controller.pid); assert.equal(observed.mm.pid, ready.mm_pid)
  assert.equal(observed.state, 'running'); assert.equal(observed.launch_kind, 'foreground')
  assert.deepEqual(requests, ['/get_module_definition'])
})
