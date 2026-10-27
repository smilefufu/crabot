import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-directory-move-')))
  const source = path.join(root, '原工作区 with space'), target = path.join(root, 'new workspace')
  fs.mkdirSync(source, { mode: 0o750 }); fs.writeFileSync(path.join(source, '.hidden'), 'original bytes', { mode: 0o600 })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, source, target }
}

test('an atomic directory move retains the original inode, hidden content, permissions and internal hard links', t => {
  const f = fixture(t), hidden = path.join(f.source, '.hidden')
  fs.linkSync(hidden, path.join(f.source, 'hard link'))
  const before = fs.lstatSync(f.source, { bigint: true }), file = fs.lstatSync(hidden, { bigint: true })
  native.renameDirectoryNoReplace(f.source, f.target)
  const after = fs.lstatSync(f.target, { bigint: true }), moved = fs.lstatSync(path.join(f.target, '.hidden'), { bigint: true })
  assert.equal(fs.existsSync(f.source), false)
  for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'mtimeNs']) assert.equal(after[key], before[key])
  for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'mtimeNs', 'nlink']) assert.equal(moved[key], file[key])
  assert.equal(fs.lstatSync(path.join(f.target, 'hard link'), { bigint: true }).ino, moved.ino)
  assert.equal(fs.readFileSync(path.join(f.target, '.hidden'), 'utf8'), 'original bytes')
})

for (const kind of ['empty directory', 'nonempty directory', 'file', 'link']) test('never replaces an existing target: ' + kind, t => {
  const f = fixture(t)
  if (kind.includes('directory')) fs.mkdirSync(f.target)
  if (kind === 'nonempty directory') fs.writeFileSync(path.join(f.target, 'retained'), 'user content')
  if (kind === 'file') fs.writeFileSync(f.target, 'user content')
  if (kind === 'link') fs.symlinkSync(f.source, f.target, process.platform === 'win32' ? 'junction' : 'dir')
  const original = fs.lstatSync(f.target, { bigint: true })
  assert.throws(() => native.renameDirectoryNoReplace(f.source, f.target), { code: 'CRABOT_DIRECTORY_MOVE' })
  assert.equal(fs.lstatSync(f.target, { bigint: true }).ino, original.ino)
  assert.equal(fs.readFileSync(path.join(f.source, '.hidden'), 'utf8'), 'original bytes')
  if (kind === 'nonempty directory') assert.equal(fs.readFileSync(path.join(f.target, 'retained'), 'utf8'), 'user content')
})

test('invalid paths, non-directories, a source link and extra arguments never move the source', t => {
  const f = fixture(t), link = path.join(f.root, 'source-link')
  fs.symlinkSync(f.source, link, process.platform === 'win32' ? 'junction' : 'dir')
  for (const args of [[f.source, f.target, 'extra'], ['', f.target], ['relative', f.target], [f.source, 'relative'],
    [f.source + '\0', f.target], [f.source + path.sep, f.target], [path.join(f.source, '.hidden'), f.target], [link, f.target]]) {
    assert.throws(() => native.renameDirectoryNoReplace(...args), { code: 'CRABOT_DIRECTORY_MOVE' })
    assert.equal(fs.existsSync(f.target), false)
    assert.equal(fs.readFileSync(path.join(f.source, '.hidden'), 'utf8'), 'original bytes')
  }
})

test('two actual processes cannot replace each other at the same new destination', async t => {
  const f = fixture(t), other = path.join(f.root, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, '.hidden'), 'other bytes')
  const module = fileURLToPath(new URL('../process-identity.cjs', import.meta.url))
  const actors = [f.source, other].map(source => {
    const child = spawn(process.execPath, ['-e', `const native=require(${JSON.stringify(module)});process.send({ready:true});process.once('message',()=>{let result;try{native.renameDirectoryNoReplace(${JSON.stringify(source)},${JSON.stringify(f.target)});result={ok:true}}catch(error){result={ok:false,code:error.code}}process.send(result,()=>process.exit(0))});setTimeout(()=>process.exit(1),15000).unref();`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const ready = once(child, 'message'), ended = once(child, 'exit')
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended })
    return { child, source, ready, ended }
  })
  await Promise.all(actors.map(item => item.ready))
  const results = actors.map(item => once(item.child, 'message'))
  for (const item of actors) item.child.send('move')
  const values = (await Promise.all(results)).map(([value]) => value)
  await Promise.all(actors.map(item => item.ended))
  assert.equal(values.filter(value => value.ok).length, 1)
  const loser = values.findIndex(value => !value.ok), winner = 1 - loser
  assert.equal(values[loser].code, 'CRABOT_DIRECTORY_MOVE')
  assert.equal(fs.existsSync(actors[loser].source), true); assert.equal(fs.existsSync(actors[winner].source), false)
  assert.equal(fs.readFileSync(path.join(f.target, '.hidden'), 'utf8'), winner === 0 ? 'original bytes' : 'other bytes')
})

test('a different Linux filesystem never causes a copy-and-delete fallback', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t)
  if (!fs.existsSync('/dev/shm') || fs.statSync('/dev/shm').dev === fs.statSync(f.source).dev) return t.skip('independent writable filesystem unavailable')
  let root
  try { root = fs.mkdtempSync('/dev/shm/crabot-directory-move-') } catch { return t.skip('independent writable filesystem unavailable') }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target')
  assert.throws(() => native.renameDirectoryNoReplace(f.source, target), { code: 'CRABOT_DIRECTORY_MOVE' })
  assert.equal(fs.existsSync(target), false); assert.equal(fs.readFileSync(path.join(f.source, '.hidden'), 'utf8'), 'original bytes')
})

test('a long target under a different parent preserves directory identity and Unicode content', t => {
  const f = fixture(t), before = fs.lstatSync(f.source, { bigint: true })
  const parent = path.join(f.root, ...Array.from({ length: 6 }, (_, index) => `parent-${index}-` + 'x'.repeat(45)))
  fs.mkdirSync(parent, { recursive: true })
  const target = path.join(parent, '目标工作区')
  assert.ok(target.length > 260)
  native.renameDirectoryNoReplace(f.source, target)
  assert.equal(fs.lstatSync(target, { bigint: true }).ino, before.ino)
  assert.equal(fs.readFileSync(path.join(target, '.hidden'), 'utf8'), 'original bytes')
})

test('a physical rename with an open file is not proof that workspace occupants stopped', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), fd = fs.openSync(path.join(f.source, '.hidden'), 'r')
  try {
    native.renameDirectoryNoReplace(f.source, f.target)
    assert.equal(fs.readFileSync(fd, 'utf8'), 'original bytes')
    assert.equal(fs.existsSync(f.source), false)
  } finally { fs.closeSync(fd) }
})


test('fully qualified Windows paths accept forward separators without disabling long paths', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  native.renameDirectoryNoReplace(f.source.replaceAll('\\', '/'), f.target.replaceAll('\\', '/'))
  assert.equal(fs.readFileSync(path.join(f.target, '.hidden'), 'utf8'), 'original bytes')
  assert.equal(fs.existsSync(f.source), false)
})
