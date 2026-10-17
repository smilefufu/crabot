import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createInstanceRuntime, recordMmProcess, clearInstanceRuntime, readInstanceRuntime } from '../instance-runtime.mjs'
import identity from '../process-identity.cjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sessionsModule = fileURLToPath(new URL('../../../crabot-admin/dist/desktop-session.js', import.meta.url))
const sessionClient = new URL('../desktop-session-client.mjs', import.meta.url).href
const localTransport = new URL('../local-auth-transport.cjs', import.meta.url).href
const frameModule = new URL('../desktop-frames.cjs', import.meta.url).href

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-desktop-session-中文 space-'))), data = join(root, 'data')
  mkdirSync(data); mkdirSync(join(root, 'crabot-admin', 'dist'), { recursive: true })
  const uiEntry = join(root, 'trusted-ui.mjs'), serverEntry = join(root, 'crabot-admin', 'dist', 'main.js')
  writeFileSync(uiEntry, `import {openDesktopSession} from ${JSON.stringify(sessionClient)};
    import transport from ${JSON.stringify(localTransport)};
    import frameModule from ${JSON.stringify(frameModule)};
    import {readFileSync} from 'node:fs';import {join} from 'node:path';
    const data=process.env.TEST_DATA;
    async function manual(nonce, action) {
      const metadata=JSON.parse(readFileSync(join(data,'desktop-session.json'),'utf8'));
      const {socket}=await transport.connectLocalAuth(metadata.socket_address);
      const frames=new frameModule.DesktopFrames(socket);
      try {
        const challenge=await frames.read();
        if(action==='oversize'){socket.write(Buffer.alloc(65537,120));await frames.read();return;}
        if(action==='timeout'){await frames.read();return;}
        frames.write({type:'open_session',protocol_version:1,instance_id:challenge.instance_id,
          generation:action==='wrong-generation'?'00000000-0000-4000-8000-000000000000':challenge.generation,
          challenge:challenge.challenge,client_nonce:nonce});
        return await frames.read();
      } finally {frames.close();socket.destroy()}
    }
    async function run(){
      try {
        const action=process.env.TEST_ACTION;
        if(action==='nonce-reuse'){
          const nonce='a'.repeat(42)+'A';const first=await manual(nonce);const second=await manual(nonce);
          process.send({type:'result',first:first.type,second:second.code});
        }else if(action){
          try {const result=await manual('b'.repeat(42)+'A',action);process.send({type:'result',result})}
          catch {process.send({type:'result',closed:true})}
        }else process.send({type:'result',session:await openDesktopSession(data)});
      }catch(error){process.send({type:'result',error:error.code??'UNAVAILABLE'})}
    }
    process.on('message',command=>{if(command==='renew')void run();if(command==='exit')process.exit(0)});
    await run();setInterval(()=>{},1000);`)
  writeFileSync(serverEntry, `const {DesktopSessions}=require(${JSON.stringify(sessionsModule)});
    const sessions=new DesktopSessions({root:process.env.TEST_ROOT,dataRoot:process.env.TEST_DATA,adminUrl:'http://127.0.0.1:23456',
      entryPolicy:{executable:process.execPath,development:true,entry:process.env.TEST_UI_ENTRY},
      issue:async(claims,exp)=>Buffer.from(JSON.stringify({sub:'admin',desktop:claims,exp})).toString('base64url')});
    process.on('message',async command=>{
      if(command.type==='validate')process.send({type:'validation',valid:sessions.validate(command.claims,command.exp)});
      if(command.type==='close'){await sessions.close();process.exit(0)}
    });
    sessions.start().then(()=>process.send({type:'ready',pid:process.pid})).catch(()=>process.exit(1));`)
  const mmEntry = join(root, 'fixture-mm.cjs')
  writeFileSync(mmEntry, `const {spawn}=require('node:child_process');let child;
    function start(){child=spawn(process.execPath,[process.env.TEST_SERVER_ENTRY],{env:process.env,stdio:['ignore','ignore','inherit','ipc']});
      child.on('message',message=>process.send(message));child.on('exit',()=>{if(process.env.TEST_RESTART==='1')start()})}
    process.on('message',command=>{if(command.type==='restart'){process.env.TEST_RESTART='1';child.send({type:'close'})}
      else if(command.type==='close'){process.env.TEST_RESTART='0';child.once('exit',()=>process.send({type:'closed'}));child.send(command)}
      else child.send(command)});
    setTimeout(start,100);`)
  const record = createInstanceRuntime({ root, dataDir: data, mmPort: 23457 })
  const mm = spawn(process.execPath, [mmEntry], { env: { ...process.env, TEST_ROOT: root, TEST_DATA: data, TEST_SERVER_ENTRY: serverEntry, TEST_UI_ENTRY: uiEntry },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  recordMmProcess(data, record.generation, mm.pid)
  const clients = new Set()
  let server
  t.after(async () => {
    clients.forEach(child => child.kill())
    if (mm.connected) {
      mm.send({ type: 'close' })
      await Promise.race([once(mm, 'message'), pause(2000)])
    }
    mm.kill()
    if (server && identity.sameProcess(server, identity.inspectProcess(server.pid))) process.kill(server.pid, 'SIGKILL')
    const current = readInstanceRuntime(data)
    if (current) clearInstanceRuntime(data, current.generation)
    rmSync(root, { recursive: true, force: true })
  })
  const [ready] = await once(mm, 'message'); assert.equal(ready.type, 'ready')
  server = identity.inspectProcess(ready.pid)
  async function client(action, trusted = true) {
    const entry = trusted ? uiEntry : join(root, 'impostor-ui.mjs')
    if (!trusted) writeFileSync(entry, readFileSync(uiEntry))
    const child = spawn(process.execPath, [entry], { env: { ...process.env, TEST_DATA: data, ...(action ? { TEST_ACTION: action } : {}) },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    clients.add(child)
    const [result] = await once(child, 'message')
    return { child, result }
  }
  async function validate(session) {
    const payload = JSON.parse(Buffer.from(session.token, 'base64url').toString())
    mm.send({ type: 'validate', claims: payload.desktop, exp: payload.exp })
    const [message] = await once(mm, 'message'); return message.valid
  }
  return { root, data, mm, client, validate, record, updateServer: pid => { server = identity.inspectProcess(pid) } }
}

test('real OS handshake issues a short human session; Admin restart and generation change invalidate it', { timeout: 20_000 }, async t => {
  const f = await fixture(t), { child, result } = await f.client()
  assert.equal(result.session.type, 'session')
  assert.equal(result.session.instance_id, f.record.instance_id)
  assert.equal(await f.validate(result.session), true)
  f.mm.send({ type: 'restart' })
  const [ready] = await once(f.mm, 'message'); assert.equal(ready.type, 'ready'); f.updateServer(ready.pid)
  assert.equal(await f.validate(result.session), false)
  child.send('renew'); const [renewed] = await once(child, 'message')
  assert.equal(await f.validate(renewed.session), true)
  const file = join(f.data, 'instance-runtime.json'), previous = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...previous, generation: randomUUID() }))
  assert.equal(await f.validate(renewed.session), false)
  child.send('renew'); const [stale] = await once(child, 'message')
  assert.equal(stale.error, 'DESKTOP_STALE_INSTANCE')
  writeFileSync(file, JSON.stringify(previous))
  const exited = once(f.mm, 'exit'); f.mm.kill('SIGKILL'); await exited
  child.send('renew'); const [lostMm] = await once(child, 'message')
  assert.equal(lostMm.error, 'DESKTOP_UNAVAILABLE')
})

test('same executable with an untrusted entry, reused nonce, wrong generation and oversized frames are refused', { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const impostor = await f.client(undefined, false)
  assert.ok(impostor.result.error); assert.equal(impostor.result.session, undefined)
  impostor.child.kill()
  const replay = await f.client('nonce-reuse')
  assert.equal(replay.result.first, 'session'); assert.equal(replay.result.second, 'DESKTOP_REPLAY'); replay.child.kill()
  const wrong = await f.client('wrong-generation')
  assert.equal(wrong.result.result.code, 'DESKTOP_STALE_INSTANCE'); wrong.child.kill()
  const oversize = await f.client('oversize')
  assert.equal(oversize.result.closed, true); oversize.child.kill()
  const valid = await f.client()
  assert.equal(valid.result.session.type, 'session')
})

test('an idle authenticated transport expires within the five-second handshake window', { timeout: 12_000 }, async t => {
  const f = await fixture(t), started = Date.now()
  const result = await f.client('timeout')
  assert.equal(result.result.closed, true)
  assert.ok(Date.now() - started >= 4500 && Date.now() - started < 7000)
  assert.equal(existsSync(join(f.data, 'desktop-session.json')), true)
})
