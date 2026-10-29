import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createInstanceRuntime, recordMmProcess, clearInstanceRuntime, identity } from '../../scripts/lib/instance-runtime.mjs'

test('actual source Electron authenticates an actual standalone Node Admin child through OS peer identity', { timeout: 20000 }, async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'crabot-source-electron-'))), data = path.join(root, 'data')
  const ui = path.join(root, 'source app'), serverEntry = path.join(root, 'crabot-admin/dist/main.js')
  mkdirSync(data); mkdirSync(ui); mkdirSync(path.dirname(serverEntry), { recursive: true })
  const electron = realpathSync(createRequire(import.meta.url)('electron'))
  const sessions = fileURLToPath(new URL('../../crabot-admin/dist/desktop-session.js', import.meta.url))
  const client = new URL('../../scripts/lib/desktop-session-client.mjs', import.meta.url).href
  writeFileSync(path.join(ui, 'package.json'), JSON.stringify({ name: 'crabot-source-session-fixture', main: 'index.cjs' }))
  writeFileSync(path.join(ui, 'index.cjs'), `const {app}=require('electron');
    app.whenReady().then(async()=>{try {const {openDesktopSession}=await import(${JSON.stringify(client)});const session=await openDesktopSession(process.env.TEST_DATA);
      console.log('CRABOT_SOURCE_SESSION '+JSON.stringify({type:session.type,generation:session.generation,node_matches_electron:process.execPath===process.env.TEST_NODE}));app.exit(0)}
    catch(error){console.error(error.code||error.message);app.exit(1)}});`)
  writeFileSync(serverEntry, `const {DesktopSessions}=require(${JSON.stringify(sessions)});
    const sessions=new DesktopSessions({root:process.env.TEST_ROOT,dataRoot:process.env.TEST_DATA,adminUrl:'http://127.0.0.1:23456',
      entryPolicy:{executable:process.env.TEST_ELECTRON,development:true,entry:process.env.TEST_UI},issue:async()=> 'fixture-short-session'});
    process.on('disconnect',()=>process.exit(0));process.on('message',async message=>{if(message==='close'){await sessions.close();process.exit(0)}});
    sessions.start().then(()=>process.send('ready')).catch(error=>{console.error(error);process.exit(1)});`)
  const mmEntry = path.join(root, 'mm.cjs')
  writeFileSync(mmEntry, `const {spawn}=require('node:child_process');const child=spawn(process.execPath,[process.env.TEST_SERVER],{env:process.env,stdio:['ignore','ignore','inherit','ipc']});
    child.on('message',message=>process.send({message,pid:child.pid}));process.on('message',message=>child.send(message));
    process.on('disconnect',()=>child.kill());child.on('exit',()=>process.exit(0));`)
  const record = createInstanceRuntime({ root, dataDir: data, mmPort: 23457 })
  const mm = spawn(process.execPath, [mmEntry], { env: { ...process.env, TEST_ROOT: root, TEST_DATA: data, TEST_SERVER: serverEntry, TEST_ELECTRON: electron, TEST_UI: ui },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let gui, server, output = '', timer
  const mmClosed = once(mm, 'close').catch(() => {})
  t.after(async () => {
    clearTimeout(timer)
    if (gui?.exitCode === null && gui.signalCode === null) gui.kill('SIGKILL')
    if (mm.connected) mm.send('close')
    await Promise.race([mmClosed, new Promise(done => setTimeout(done, 2000))])
    if (server && identity.sameProcess(server, identity.inspectProcess(server.pid))) process.kill(server.pid, 'SIGKILL')
    if (mm.exitCode === null && mm.signalCode === null) mm.kill('SIGKILL')
    await mmClosed; clearInstanceRuntime(data, record.generation); rmSync(root, { recursive: true, force: true })
  })
  mm.stderr.on('data', value => { output += value })
  recordMmProcess(data, record.generation, mm.pid)
  const [ready] = await once(mm, 'message', { signal: AbortSignal.timeout(5000) }); assert.equal(ready.message, 'ready', output)
  server = identity.inspectProcess(ready.pid)
  const env = { ...process.env, TEST_DATA: data, TEST_NODE: process.execPath }; delete env.ELECTRON_RUN_AS_NODE
  gui = spawn(electron, [ui], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  gui.stdout.on('data', value => { output += value }); gui.stderr.on('data', value => { output += value })
  let code
  try { [code] = await once(gui, 'close', { signal: AbortSignal.timeout(12000) }) }
  catch (error) { throw new Error('Source Electron fixture failed: ' + output, { cause: error }) }
  assert.equal(code, 0, output)
  const line = output.split('\n').find(value => value.startsWith('CRABOT_SOURCE_SESSION ')); assert.ok(line, output)
  const result = JSON.parse(line.slice('CRABOT_SOURCE_SESSION '.length))
  assert.equal(result.type, 'session'); assert.equal(result.generation, record.generation); assert.equal(result.node_matches_electron, false)
})
