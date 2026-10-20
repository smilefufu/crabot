import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'

for (const mode of ['permit', 'cancel', 'wrong-generation']) test('fixed POSIX unpacker has no file effects before its private gate: ' + mode, { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'workspace-tar-gate-'))), source = path.join(root, 'source'), target = path.join(root, 'target')
  fs.mkdirSync(source); fs.mkdirSync(target); fs.writeFileSync(path.join(source, '.hidden'), 'original bytes')
  const module = new URL('../workspace-tar.mjs', import.meta.url).href, identityModule = new URL('../process-identity.cjs', import.meta.url).href
  const code = `import{spawnWorkspaceTar}from ${JSON.stringify(module)};import native from ${JSON.stringify(identityModule)};
    const actor=await spawnWorkspaceTar('unpack');process.stdin.on('error',()=>{});actor.child.stdin.on('error',()=>{});actor.child.stdout.resume();process.stdin.pipe(actor.child.stdin);
    process.send({kind:'ready',identity:actor.identity});process.once('message',async message=>{let error;
      try{if(message==='cancel')actor.cancel();else{if(message==='wrong-generation'){const inspect=native.inspectProcess;native.inspectProcess=pid=>pid===actor.identity.pid?{...inspect(pid),started:'replacement'}:inspect(pid)}await actor.permit()}}
      catch(e){error=e.code;actor.cancel()}
      const status=await actor.closed;process.stdin.destroy();process.send({kind:'finished',status,error},()=>process.exit(0))});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: target, stdio: ['pipe', 'ignore', 'pipe', 'ipc'] }), ended = once(child, 'exit')
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes }); child.stdin.on('error', () => {})
  let pack, packed, actor
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
    if (pack) { if (pack.exitCode === null && pack.signalCode === null) pack.kill('SIGKILL'); await packed }
    if (actor && !native.isProcessExited(actor.pid)) native.terminateKnownProcess(actor)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const [ready] = await once(child, 'message'); actor = ready.identity
  assert.equal(ready.kind, 'ready'); assert.equal(actor.parent, child.pid)
  pack = spawn('/usr/bin/tar', ['-cf', '-', '.'], { cwd: source, stdio: ['ignore', 'pipe', 'inherit'] }); packed = once(pack, 'exit')
  pack.stdout.pipe(child.stdin)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(fs.readdirSync(target), []); assert.equal(native.isProcessExited(actor.pid), false)
  const finished = once(child, 'message'); child.send(mode)
  const [result] = await finished; assert.equal((await ended)[0], 0, stderr); await packed
  assert.equal(result.kind, 'finished')
  if (mode === 'permit') { assert.equal(result.error, undefined, stderr); assert.equal(result.status, 0, stderr); assert.equal(fs.readFileSync(path.join(target, '.hidden'), 'utf8'), 'original bytes') }
  else { assert.equal(result.status, 125); assert.deepEqual(fs.readdirSync(target), []) }
  if (mode === 'wrong-generation') assert.equal(result.error, 'WORKSPACE_COPY_ACTOR_UNVERIFIED')
  assert.equal(fs.readFileSync(path.join(source, '.hidden'), 'utf8'), 'original bytes')
})
