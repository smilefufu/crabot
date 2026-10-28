import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import native from '../process-identity.cjs'
import { inspectWorkspaceFileMetadata } from '../workspace-file-metadata.mjs'

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-file-metadata-中文 space-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'file'); await fs.writeFile(file, 'original content', { mode: 0o640 })
  return { root, file }
}

test('ordinary file and directory metadata are stable and read-only, without reading default file content', async t => {
  const { root, file } = await fixture(t), before = await fs.lstat(file, { bigint: true })
  const first = await inspectWorkspaceFileMetadata(file)
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/); assert.equal(first.named_streams, 0)
  assert.deepEqual(await inspectWorkspaceFileMetadata(file), first)
  assert.match((await inspectWorkspaceFileMetadata(root)).fingerprint, /^[a-f0-9]{64}$/)
  const after = await fs.lstat(file, { bigint: true })
  for (const key of ['ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs']) assert.equal(after[key], before[key])
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})

test('invalid metadata paths and extra arguments are rejected without writes', async t => {
  const { file } = await fixture(t)
  for (const args of [[], [file, 'extra'], ['relative'], [''], [file + '\0'], [file + path.sep], [42]]) {
    assert.throws(() => native.inspectFileMetadata(...args), { code: 'CRABOT_FILE_METADATA' })
  }
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})

test('permissions, timestamps and extended attributes change the independent metadata proof', { skip: process.platform === 'win32' }, async t => {
  const { file } = await fixture(t), original = await inspectWorkspaceFileMetadata(file)
  await fs.chmod(file, 0o600)
  const restricted = await inspectWorkspaceFileMetadata(file); assert.notEqual(restricted.fingerprint, original.fingerprint)
  await fs.utimes(file, 1700000000, 1700000000)
  const timed = await inspectWorkspaceFileMetadata(file); assert.notEqual(timed.fingerprint, restricted.fingerprint)
  const name = process.platform === 'darwin' ? 'org.crabot.fixture' : 'user.crabot.fixture'
  if (process.platform === 'darwin') execFileSync('/usr/bin/xattr', ['-w', name, 'first', file])
  else execFileSync('python3', ['-c', 'import os,sys;os.setxattr(sys.argv[1],sys.argv[2],b"first")', file, name])
  const attributed = await inspectWorkspaceFileMetadata(file); assert.notEqual(attributed.fingerprint, timed.fingerprint)
  if (process.platform === 'darwin') execFileSync('/usr/bin/xattr', ['-w', name, 'other', file])
  else execFileSync('python3', ['-c', 'import os,sys;os.setxattr(sys.argv[1],sys.argv[2],b"other")', file, name])
  assert.notEqual((await inspectWorkspaceFileMetadata(file)).fingerprint, attributed.fingerprint)
})

test('POSIX relative links are inspected without following or opening their target', { skip: process.platform === 'win32' }, async t => {
  const { root } = await fixture(t), link = path.join(root, 'relative')
  await fs.symlink('target-does-not-exist', link)
  assert.match((await inspectWorkspaceFileMetadata(link)).fingerprint, /^[a-f0-9]{64}$/)
  await assert.rejects(fs.stat(link), { code: 'ENOENT' })
  assert.equal(await fs.readlink(link), 'target-does-not-exist')
})

test('a macOS access ACL is included independently from mode bits and ordinary bytes', { skip: process.platform !== 'darwin' }, async t => {
  const { file } = await fixture(t), before = await inspectWorkspaceFileMetadata(file), stat = await fs.lstat(file)
  execFileSync('/bin/chmod', ['+a', 'everyone deny delete', file])
  try {
    assert.equal((await fs.lstat(file)).mode, stat.mode)
    assert.notEqual((await inspectWorkspaceFileMetadata(file)).fingerprint, before.fingerprint)
    assert.equal(await fs.readFile(file, 'utf8'), 'original content')
  } finally { execFileSync('/bin/chmod', ['-N', file]) }
})

test('Windows named streams are hashed even when their sizes and ordinary file bytes are unchanged', { skip: process.platform !== 'win32' }, async t => {
  const { file } = await fixture(t), stream = file + ':Zone.Identifier'
  await fs.writeFile(stream, 'first'); const first = await inspectWorkspaceFileMetadata(file)
  assert.equal(first.named_streams, 1)
  const before = await fs.stat(file)
  await fs.writeFile(stream, 'other'); await fs.utimes(file, before.atime, before.mtime)
  assert.notEqual((await inspectWorkspaceFileMetadata(file)).fingerprint, first.fingerprint)
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})

test('Windows access ACL changes and root reparse points cannot be mistaken for unchanged metadata', { skip: process.platform !== 'win32' }, async t => {
  const { root, file } = await fixture(t), before = await inspectWorkspaceFileMetadata(file)
  execFileSync(path.join(process.env.SystemRoot, 'System32/icacls.exe'), [file, '/inheritance:d'])
  assert.notEqual((await inspectWorkspaceFileMetadata(file)).fingerprint, before.fingerprint)
  const link = path.join(root, 'junction'); await fs.symlink(root, link, 'junction')
  await assert.rejects(inspectWorkspaceFileMetadata(link), { code: 'CRABOT_FILE_METADATA' })
})

test('pre-cancelled inspection does not read metadata or mutate the file', async t => {
  const { file } = await fixture(t), controller = new AbortController(); controller.abort()
  await assert.rejects(inspectWorkspaceFileMetadata(file, { signal: controller.signal }), { code: 'CRABOT_FILE_METADATA_CANCELLED' })
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})

async function copyFixture(t) {
  const { root, file } = await fixture(t), source = path.join(root, 'source'), target = path.join(root, 'target')
  await fs.mkdir(source, { mode: 0o750 }); await fs.rename(file, path.join(source, '.hidden'))
  await fs.utimes(path.join(source, '.hidden'), 1700000000, 1700000000)
  await fs.cp(source, target, { recursive: true, preserveTimestamps: true })
  // Directory mtime is deliberately equal; default-content verification alone cannot detect the changes below.
  for (const directory of [source, target]) await fs.utimes(directory, 1700000000, 1700000000)
  return { source, target, file: path.join(source, '.hidden'), copy: path.join(target, '.hidden') }
}

test('the combined copy proof verifies default content, directory and file metadata independently', async t => {
  const { source, target } = await copyFixture(t)
  const { verifyWorkspaceRelocationCopy } = await import('../workspace-file-metadata.mjs')
  const result = await verifyWorkspaceRelocationCopy(source, target)
  assert.equal(result.files, 1); assert.equal(result.verified_bytes, 16); assert.equal(result.metadata_entries, 2)
  assert.match(result.metadata_fingerprint, /^[a-f0-9]{64}$/)
})

test('equal bytes and names cannot hide lost POSIX file permissions or root metadata', { skip: process.platform === 'win32' }, async t => {
  const { source, target, copy } = await copyFixture(t)
  const { verifyWorkspaceRelocationCopy } = await import('../workspace-file-metadata.mjs')
  await fs.chmod(copy, 0o600)
  await assert.rejects(verifyWorkspaceRelocationCopy(source, target), { code: 'CRABOT_FILE_METADATA' })
  await fs.chmod(copy, 0o640); await fs.chmod(target, 0o700)
  await assert.rejects(verifyWorkspaceRelocationCopy(source, target), { code: 'CRABOT_FILE_METADATA' })
  assert.equal(await fs.readFile(copy, 'utf8'), 'original content')
})

test('equal default content cannot hide lost macOS xattrs or an access ACL', { skip: process.platform !== 'darwin' }, async t => {
  const { source, target, file, copy } = await copyFixture(t)
  const { verifyWorkspaceRelocationCopy } = await import('../workspace-file-metadata.mjs')
  execFileSync('/usr/bin/xattr', ['-w', 'org.crabot.fixture', 'retained value', file])
  await assert.rejects(verifyWorkspaceRelocationCopy(source, target), { code: 'CRABOT_FILE_METADATA' })
  execFileSync('/usr/bin/xattr', ['-w', 'org.crabot.fixture', 'retained value', copy])
  await verifyWorkspaceRelocationCopy(source, target)
  execFileSync('/bin/chmod', ['+a', 'everyone deny delete', file])
  try { await assert.rejects(verifyWorkspaceRelocationCopy(source, target), { code: 'CRABOT_FILE_METADATA' }) }
  finally { execFileSync('/bin/chmod', ['-N', file]) }
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})

test('equal default content cannot hide a changed Windows named stream', { skip: process.platform !== 'win32' }, async t => {
  const { source, target, file, copy } = await copyFixture(t)
  const { verifyWorkspaceRelocationCopy } = await import('../workspace-file-metadata.mjs')
  await fs.writeFile(file + ':Zone.Identifier', 'first'); await fs.writeFile(copy + ':Zone.Identifier', 'other')
  for (const entry of [file, copy]) await fs.utimes(entry, 1700000000, 1700000000)
  await assert.rejects(verifyWorkspaceRelocationCopy(source, target), { code: 'CRABOT_FILE_METADATA' })
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})

test('a Linux access ACL is included independently from the same mode bits and bytes', { skip: process.platform !== 'linux' }, async t => {
  const { file } = await fixture(t), before = await inspectWorkspaceFileMetadata(file), stat = await fs.lstat(file)
  execFileSync('python3', ['-c', `import ctypes,sys
lib=ctypes.CDLL('libacl.so.1',use_errno=True)
lib.acl_from_text.argtypes=[ctypes.c_char_p];lib.acl_from_text.restype=ctypes.c_void_p
lib.acl_set_file.argtypes=[ctypes.c_char_p,ctypes.c_int,ctypes.c_void_p];lib.acl_set_file.restype=ctypes.c_int
lib.acl_free.argtypes=[ctypes.c_void_p]
acl=lib.acl_from_text(b'u::rw-,u:65534:r--,g::r--,m::r--,o::---')
if not acl: raise OSError(ctypes.get_errno(),'acl_from_text')
try:
 if lib.acl_set_file(sys.argv[1].encode(),0x8000,acl): raise OSError(ctypes.get_errno(),'acl_set_file')
finally: lib.acl_free(acl)
`, file])
  assert.equal((await fs.lstat(file)).mode, stat.mode)
  assert.notEqual((await inspectWorkspaceFileMetadata(file)).fingerprint, before.fingerprint)
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})

test('a permission mutation during inspection is rejected rather than represented as a stable snapshot', { skip: process.platform === 'win32' }, async t => {
  const { file } = await fixture(t), inspect = native.inspectFileMetadata; let changed = false
  t.mock.method(native, 'inspectFileMetadata', target => {
    const result = inspect(target)
    if (!changed) { changed = true; execFileSync('/bin/chmod', ['600', target]) }
    return result
  })
  await assert.rejects(inspectWorkspaceFileMetadata(file), { code: 'CRABOT_FILE_METADATA' })
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})

test('unreadable Native metadata is not silently replaced with a mode-only proof', async t => {
  const { file } = await fixture(t)
  t.mock.method(native, 'inspectFileMetadata', () => { throw Object.assign(new Error('unavailable'), { code: 'CRABOT_FILE_METADATA' }) })
  await assert.rejects(inspectWorkspaceFileMetadata(file), { code: 'CRABOT_FILE_METADATA' })
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})

test('a same-volume atomic move retains the independent root and file metadata proof', { skip: process.platform === 'win32' }, async t => {
  const { root, file } = await fixture(t), source = path.join(root, 'source'), target = path.join(root, 'moved')
  await fs.mkdir(source, { mode: 0o750 }); await fs.rename(file, path.join(source, 'file'))
  const a = await inspectWorkspaceFileMetadata(source), b = await inspectWorkspaceFileMetadata(path.join(source, 'file'))
  native.renameDirectoryNoReplace(source, target)
  assert.deepEqual(await inspectWorkspaceFileMetadata(target), a)
  assert.deepEqual(await inspectWorkspaceFileMetadata(path.join(target, 'file')), b)
  assert.equal(await fs.readFile(path.join(target, 'file'), 'utf8'), 'original content')
})

test('Linux nodump is visible even when ordinary mode bits and file bytes are unchanged', { skip: process.platform !== 'linux' }, async t => {
  const { file } = await fixture(t), before = await inspectWorkspaceFileMetadata(file), stat = await fs.lstat(file)
  execFileSync('chattr', ['+d', file])
  try {
    assert.equal((await fs.lstat(file)).mode, stat.mode)
    assert.notEqual((await inspectWorkspaceFileMetadata(file)).fingerprint, before.fingerprint)
  } finally { execFileSync('chattr', ['-d', file]) }
})

test('cancelling while hashing a real Windows named stream closes its handle before returning', { skip: process.platform !== 'win32' }, async t => {
  const { file } = await fixture(t), streamFile = file + ':large-stream'
  await fs.writeFile(streamFile, Buffer.alloc(3 * 1024 * 1024, 7))
  const open = fs.open.bind(fs), controller = new AbortController(); let read = false, closed = false
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args)
    if (args[0] === streamFile) {
      const create = handle.createReadStream.bind(handle), close = handle.close.bind(handle)
      handle.createReadStream = options => {
        const stream = create(options); stream.once('data', () => { read = true; controller.abort() }); return stream
      }
      handle.close = async () => { await close(); closed = true }
    }
    return handle
  })
  await assert.rejects(inspectWorkspaceFileMetadata(file, { signal: controller.signal }), { code: 'CRABOT_FILE_METADATA_CANCELLED' })
  assert.equal(read, true); assert.equal(closed, true)
  assert.equal(await fs.readFile(file, 'utf8'), 'original content')
})
