import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import identity from '../process-identity.cjs'
import { discoverLegacyUserInstall } from '../legacy-desktop.mjs'
import { discoverLegacyRuntime, withVerifiedLegacyRuntime } from '../legacy-runtime.mjs'

const sample = new URL('../../../.desktop-build/legacy-2026.10.15.1/source/crabot-v2026.10.15.1-darwin-arm64/', import.meta.url)
const available = await fs.stat(sample).then(() => true, () => false)
const catalog = JSON.parse(await fs.readFile(new URL('../../desktop/legacy-releases.json', import.meta.url), 'utf8'))
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'crabot-legacy-runtime-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = path.join(parent, 'old'), data = path.join(parent, 'custom-data')
  await fs.mkdir(root); await fs.mkdir(data); await fs.mkdir(path.join(data, 'agent')); await fs.mkdir(path.join(root, 'crabot-agent'))
  for (const name of Object.keys({ ...catalog.files, ...catalog.version_files['v2026.10.15.1'] })) {
    const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(new URL(name, sample), target)
  }
  await fs.writeFile(path.join(root, 'VERSION'), 'v2026.10.15.1')
  return { parent, root, data, installation: await discoverLegacyUserInstall({ root, dataDir: data }) }
}

test('real old entry hashes plus no launcher or module records establish a stopped discovery only', { skip: !available }, async t => {
  const f = await fixture(t)
  t.mock.method(identity, 'listProcessIds', () => [])
  assert.equal((await discoverLegacyRuntime(f.installation)).state, 'stopped')
  await fs.mkdir(path.join(f.data, 'module-runtime-registry/records'), { recursive: true })
  await fs.writeFile(path.join(f.data, 'module-runtime-registry/records/unsettled.json'), '{}')
  await assert.rejects(discoverLegacyRuntime(f.installation), /运行记录尚未收口/)
  assert.equal(await fs.readFile(path.join(f.root, 'VERSION'), 'utf8'), 'v2026.10.15.1')
})

test('a copied PID file does not adopt or signal the process it names', { skip: !available }, async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  t.mock.method(identity, 'listProcessIds', () => [])
  await assert.rejects(discoverLegacyRuntime(f.installation), /PID 不属于/)
  assert.equal(await fs.readFile(path.join(f.data, 'mm.pid'), 'utf8'), String(process.pid))
})

for (const correctData of [true, false]) test('controlled MM protocol fixture binds its actual DataRoot: ' + correctData, { skip: !available, timeout: 20_000 }, async t => {
  const f = await fixture(t), requests = []
  const actualData = correctData ? f.data : path.join(f.parent, 'another-instance')
  if (!correctData) { await fs.mkdir(actualData); await fs.mkdir(path.join(actualData, 'agent')) }
  const source = `const http=require('node:http'),path=require('node:path');const server=http.createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const body=JSON.parse(text);process.send({request:req.url});res.end(JSON.stringify({id:body.id,success:true,data:{definition:{module_id:'crabot-agent',cwd:path.join(process.argv[2],'crabot-agent'),env:{DATA_DIR:process.argv[1],CRABOT_AGENT_DATA_DIR:path.join(process.argv[1],'agent')}}}}))});server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}))`
  const child = spawn(process.execPath, ['-e', source, actualData, f.root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  child.on('message', message => { if (message.request) requests.push(message.request) })
  t.after(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exit = once(child, 'exit'); child.kill(); await exit })
  await once(child, 'message')
  // Only argv is substituted. PID/start/owner/parent/executable, TCP listener and
  // HTTP connection are real OS evidence. No full business MM runs on this host.
  t.mock.method(identity, 'listProcessIds', () => [process.pid, child.pid])
  t.mock.method(identity, 'inspectProcessArguments', pid => [process.execPath,
    path.join(f.root, pid === process.pid ? 'scripts/supervisor.mjs' : 'crabot-core/dist/main.js')])
  await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  if (correctData) {
    const state = await withVerifiedLegacyRuntime(f.installation, async (snapshot, rpc) => {
      assert.equal(snapshot.state, 'running'); assert.equal(snapshot.mm.pid, child.pid)
      await rpc.shutdown(); return snapshot
    })
    assert.equal(state.launch_kind, 'daemon')
    assert.deepEqual(requests, ['/get_module_definition', '/shutdown'])
  } else {
    await assert.rejects(discoverLegacyRuntime(f.installation), /实际数据目录/)
    assert.deepEqual(requests, ['/get_module_definition'])
  }
  assert.equal(await fs.readFile(path.join(f.data, 'mm.pid'), 'utf8'), String(process.pid))
})
