import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import native from '../process-identity.cjs'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-file-move-')))
  const source = path.join(root, '收尾 with space.json'), target = path.join(root, 'released.json')
  fs.writeFileSync(source, 'sealed original bytes\n', { mode: 0o600 })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, source, target }
}
test('an atomic file move preserves bytes and the original single-link file identity', t => {
  const f = fixture(t), before = fs.lstatSync(f.source, { bigint: true })
  native.renameFileNoReplace(f.source, f.target)
  assert.equal(fs.existsSync(f.source), false)
  const after = fs.lstatSync(f.target, { bigint: true })
  for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'nlink']) assert.equal(after[key], before[key])
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'sealed original bytes\n')
})
for (const kind of ['file', 'empty directory', 'nonempty directory', 'link']) test('an atomic file move never overwrites an existing ' + kind, t => {
  const f = fixture(t)
  if (kind === 'file') fs.writeFileSync(f.target, 'retain target')
  else if (kind === 'link') fs.symlinkSync(f.root, f.target, process.platform === 'win32' ? 'junction' : 'dir')
  else { fs.mkdirSync(f.target); if (kind === 'nonempty directory') fs.writeFileSync(path.join(f.target, 'retain'), 'retain target') }
  const before = fs.lstatSync(f.target, { bigint: true })
  assert.throws(() => native.renameFileNoReplace(f.source, f.target), { code: 'CRABOT_FILE_MOVE' })
  assert.equal(fs.lstatSync(f.target, { bigint: true }).ino, before.ino)
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'sealed original bytes\n')
  if (kind === 'file') assert.equal(fs.readFileSync(f.target, 'utf8'), 'retain target')
})
test('invalid paths, directories and multiple-link sources remain untouched', t => {
  const f = fixture(t), link = path.join(f.root, 'hardlink')
  for (const args of [[f.source, f.target, 'extra'], ['', f.target], ['relative', f.target], [f.source, 'relative'],
    [f.source + '\0', f.target], [f.source + path.sep, f.target], [f.root, f.target], [f.source, f.source]]) {
    assert.throws(() => native.renameFileNoReplace(...args), { code: 'CRABOT_FILE_MOVE' })
    assert.equal(fs.existsSync(f.target), false)
  }
  fs.linkSync(f.source, link)
  assert.throws(() => native.renameFileNoReplace(f.source, f.target), { code: 'CRABOT_FILE_MOVE' })
  assert.equal(fs.readFileSync(link, 'utf8'), 'sealed original bytes\n')
  assert.equal(fs.existsSync(f.source), true)
})
test('a symbolic source is not followed', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), link = path.join(f.root, 'symbolic')
  fs.symlinkSync(f.source, link)
  assert.throws(() => native.renameFileNoReplace(link, f.target), { code: 'CRABOT_FILE_MOVE' })
  assert.equal(fs.existsSync(f.target), false)
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'sealed original bytes\n')
})
test('long Unicode destination retains the same ordinary file', t => {
  const f = fixture(t), parent = path.join(f.root, ...Array.from({ length: 6 }, (_, i) => 'parent-' + i + '-'.repeat(45)))
  fs.mkdirSync(parent, { recursive: true }); const target = path.join(parent, '原收尾.json')
  assert.ok(target.length > 260)
  const before = fs.lstatSync(f.source, { bigint: true })
  native.renameFileNoReplace(f.source, target)
  assert.equal(fs.lstatSync(target, { bigint: true }).ino, before.ino)
  assert.equal(fs.readFileSync(target, 'utf8'), 'sealed original bytes\n')
})
test('a different filesystem is never changed by a copy-and-delete fallback', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t)
  if (!fs.existsSync('/dev/shm') || fs.statSync('/dev/shm').dev === fs.statSync(f.source).dev) return t.skip('independent filesystem unavailable')
  const root = fs.mkdtempSync('/dev/shm/crabot-file-move-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'released.json')
  assert.throws(() => native.renameFileNoReplace(f.source, target), { code: 'CRABOT_FILE_MOVE' })
  assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(f.source), true)
})
test('two actual processes cannot replace the winning file', async t => {
  const f = fixture(t), other = path.join(f.root, 'other.json'); fs.writeFileSync(other, 'other bytes')
  const module = fileURLToPath(new URL('../process-identity.cjs', import.meta.url))
  const actors = [f.source, other].map(source => {
    const child = spawn(process.execPath, ['-e', `const native=require(${JSON.stringify(module)});process.send({ready:true});process.once('message',()=>{let result;try{native.renameFileNoReplace(${JSON.stringify(source)},${JSON.stringify(f.target)});result={ok:true}}catch(error){result={ok:false,code:error.code}}process.send(result,()=>process.exit(0))});setTimeout(()=>process.exit(1),15000).unref();`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const ready = once(child, 'message'), ended = once(child, 'exit')
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended })
    return { child, source, ready, ended }
  })
  await Promise.all(actors.map(item => item.ready))
  const replies = actors.map(item => once(item.child, 'message'))
  for (const item of actors) item.child.send('move')
  const results = (await Promise.all(replies)).map(([item]) => item)
  await Promise.all(actors.map(item => item.ended))
  assert.equal(results.filter(item => item.ok).length, 1)
  const loser = results.findIndex(item => !item.ok), winner = 1 - loser
  assert.equal(results[loser].code, 'CRABOT_FILE_MOVE')
  assert.equal(fs.existsSync(actors[loser].source), true)
  assert.equal(fs.existsSync(actors[winner].source), false)
  assert.equal(fs.readFileSync(f.target, 'utf8'), winner === 0 ? 'sealed original bytes\n' : 'other bytes')
})

test('an occupied Windows source stays intact until its actual handle is closed', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const f = fixture(t)
  const script = "$ErrorActionPreference='Stop';$file=[IO.File]::Open($env:CRABOT_FILE_MOVE_SOURCE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::WriteLine('held');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$file.Dispose()}"
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, CRABOT_FILE_MOVE_SOURCE: f.source }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const ended = once(child, 'exit'); let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Finite file holder did not become ready')), 15000)
      let output = ''; child.stdout.on('data', chunk => { output += chunk; if (output.includes('held')) resolve() })
      child.once('error', reject); child.once('exit', () => reject(new Error('Finite holder exited before its handle was checked')))
    })
    clearTimeout(timer)
    assert.throws(() => native.renameFileNoReplace(f.source, f.target), { code: 'CRABOT_FILE_MOVE' })
    assert.equal(fs.existsSync(f.target), false)
    assert.equal(fs.readFileSync(f.source, 'utf8'), 'sealed original bytes\n')
    child.stdin.end('release\n'); await ended
    native.renameFileNoReplace(f.source, f.target)
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'sealed original bytes\n')
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
  }
})
