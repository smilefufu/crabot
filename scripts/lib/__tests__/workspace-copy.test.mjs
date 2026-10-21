import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { inspectWorkspaceCopySource, copyWorkspaceToStaging } from '../workspace-copy.mjs'
import { runBounded } from '../run-bounded.mjs'

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-staging-copy-中文 space-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), container = path.join(root, 'staging')
  await fs.mkdir(source, { mode: 0o750 }); await fs.mkdir(path.join(source, '.git')); await fs.mkdir(path.join(source, 'empty'))
  await fs.writeFile(path.join(source, '.git/config'), '[core]\n', { mode: 0o600 })
  await fs.writeFile(path.join(source, 'file'), Buffer.from([0, 255, 7]), { mode: 0o640 })
  return { root, source, container }
}

test('actual OS copy keeps hidden bytes, empty directories and source identity before independent verification', async t => {
  const { source, container } = await fixture(t), original = await fs.lstat(source, { bigint: true })
  const preview = await inspectWorkspaceCopySource(source), copied = await copyWorkspaceToStaging(source, container)
  assert.equal(copied.files, 2); assert.equal(copied.verified_bytes, 10)
  assert.equal(copied.metadata_fingerprint, preview.metadata_fingerprint)
  assert.deepEqual(await fs.readFile(path.join(copied.target, 'file')), Buffer.from([0, 255, 7]))
  assert.deepEqual(await fs.readdir(path.join(copied.target, 'empty')), [])
  assert.equal((await fs.lstat(source, { bigint: true })).ino, original.ino)
  assert.notEqual((await fs.lstat(copied.target, { bigint: true })).ino, original.ino)
  assert.equal(await fs.readFile(path.join(source, '.git/config'), 'utf8'), '[core]\n')
})

for (const existing of ['empty directory', 'nonempty directory', 'file']) test('existing staging is never adopted or replaced: ' + existing, async t => {
  const { source, container } = await fixture(t)
  if (existing === 'file') await fs.writeFile(container, 'user content')
  else { await fs.mkdir(container); if (existing === 'nonempty directory') await fs.writeFile(path.join(container, 'keep'), 'user content') }
  const before = await fs.lstat(container, { bigint: true })
  await assert.rejects(copyWorkspaceToStaging(source, container))
  assert.equal((await fs.lstat(container, { bigint: true })).ino, before.ino)
  if (existing === 'file') assert.equal(await fs.readFile(container, 'utf8'), 'user content')
  if (existing === 'nonempty directory') assert.equal(await fs.readFile(path.join(container, 'keep'), 'utf8'), 'user content')
})

test('structural blockers and overlapping targets are rejected before creating staging', async t => {
  const { root, source, container } = await fixture(t)
  await fs.writeFile(path.join(source, 'pyvenv.cfg'), 'not safely relocatable')
  await assert.rejects(copyWorkspaceToStaging(source, container), { code: 'WORKSPACE_COPY_UNVERIFIED' })
  await assert.rejects(fs.stat(container), { code: 'ENOENT' })
  await assert.rejects(copyWorkspaceToStaging(source, path.join(source, 'staging')), { code: 'WORKSPACE_COPY_UNVERIFIED' })
  await assert.rejects(copyWorkspaceToStaging(source, root), { code: 'WORKSPACE_COPY_UNVERIFIED' })
})

test('POSIX internal hardlinks and relative links retain their topology', { skip: process.platform === 'win32' }, async t => {
  const { source, container } = await fixture(t)
  await fs.link(path.join(source, 'file'), path.join(source, 'hard link'))
  await fs.symlink('file', path.join(source, 'relative'))
  const result = await copyWorkspaceToStaging(source, container)
  assert.equal(await fs.readlink(path.join(result.target, 'relative')), 'file')
  assert.equal((await fs.lstat(path.join(result.target, 'file'), { bigint: true })).ino, (await fs.lstat(path.join(result.target, 'hard link'), { bigint: true })).ino)
})

test('actual macOS copy retains access ACLs and binary extended attributes', { skip: process.platform !== 'darwin' }, async t => {
  const { source, container } = await fixture(t), file = path.join(source, 'file')
  execFileSync('/usr/bin/xattr', ['-wx', 'org.crabot.fixture', '00ff0100', file])
  execFileSync('/bin/chmod', ['+a', 'everyone deny delete', file])
  let target
  try {
    const result = await copyWorkspaceToStaging(source, container); target = path.join(result.target, 'file')
    assert.equal(execFileSync('/usr/bin/xattr', ['-px', 'org.crabot.fixture', target], { encoding: 'utf8' }).replace(/\s/g, ''), '00FF0100')
  } finally {
    execFileSync('/bin/chmod', ['-N', file])
    // The failed stage is retained too; drop only this fixture ACL to allow fixture cleanup.
    try { execFileSync('/bin/chmod', ['-N', target ?? path.join(container, 'tree/file')], { stdio: 'ignore' }) } catch {}
  }
})

test('pre-cancelled copy has no filesystem side effects', async t => {
  const { source, container } = await fixture(t), controller = new AbortController(); controller.abort()
  await assert.rejects(copyWorkspaceToStaging(source, container, { signal: controller.signal }), { code: 'CRABOT_PREPARATION_CANCELLED' })
  await assert.rejects(fs.stat(container), { code: 'ENOENT' })
})

test('bounded runner retains strict exit-code handling and rejects invalid inherited descriptors before spawn', async () => {
  await runBounded(process.execPath, ['-e', 'process.exit(0)'])
  for (const code of [1, 8]) await assert.rejects(runBounded(process.execPath, ['-e', 'process.exit(' + code + ')']))
  for (const fd of [-1, 1.5, NaN, '3']) assert.throws(() => runBounded(process.execPath, ['-e', 'process.exit(0)'], { extraFileDescriptors: [fd] }))
})

test('macOS staging removes inherited ACL only on the new private container', { skip: process.platform !== 'darwin' }, async t => {
  const { root, source, container } = await fixture(t)
  execFileSync('/bin/chmod', ['+a', 'everyone allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit', root])
  try {
    const result = await copyWorkspaceToStaging(source, container)
    assert.equal((await fs.lstat(container)).mode & 0o777, 0o700)
    assert.doesNotMatch(execFileSync('/bin/ls', ['-lde', container], { encoding: 'utf8' }), /\n\s*\d+:/)
    assert.match(execFileSync('/bin/ls', ['-lde', root], { encoding: 'utf8' }), /\n\s*\d+:/)
    assert.equal(await fs.readFile(path.join(result.target, '.git/config'), 'utf8'), '[core]\n')
  } finally { execFileSync('/bin/chmod', ['-N', root]) }
})

test('two concurrent copies cannot adopt the same staging container', async t => {
  const { source, container } = await fixture(t)
  const results = await Promise.allSettled([copyWorkspaceToStaging(source, container), copyWorkspaceToStaging(source, container)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter(item => item.status === 'rejected').length, 1)
  assert.equal(await fs.readFile(path.join(source, '.git/config'), 'utf8'), '[core]\n')
})

test('Windows internal hardlinks are rejected before staging rather than copied as unrelated files', { skip: process.platform !== 'win32' }, async t => {
  const { source, container } = await fixture(t)
  await fs.link(path.join(source, 'file'), path.join(source, 'hard'))
  await assert.rejects(copyWorkspaceToStaging(source, container), { code: 'WORKSPACE_COPY_LINK_UNSUPPORTED' })
  await assert.rejects(fs.stat(container), { code: 'ENOENT' })
})

test('Linux filesystem flags unsupported by archive copy are reported before staging', { skip: process.platform !== 'linux' }, async t => {
  const { source, container } = await fixture(t), file = path.join(source, 'file')
  execFileSync('chattr', ['+d', file])
  try {
    await assert.rejects(copyWorkspaceToStaging(source, container), { code: 'WORKSPACE_COPY_METADATA_UNSUPPORTED' })
    await assert.rejects(fs.stat(container), { code: 'ENOENT' })
  } finally { execFileSync('chattr', ['-d', file]) }
})

for (const replace of ['source', 'container']) test('pinned POSIX copy never follows a replaced ' + replace + ' root', { skip: process.platform === 'win32' }, async t => {
  const { root, source, container } = await fixture(t), outside = path.join(root, 'outside'), retained = path.join(root, 'retained-original')
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'canary'), 'must not change')
  const open = fs.open.bind(fs); let changed = false
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args)
    if (!changed && args[0] === (replace === 'source' ? source : container)) {
      changed = true
      await fs.rename(args[0], retained); await fs.symlink(outside, args[0], 'dir')
    }
    return handle
  })
  await assert.rejects(copyWorkspaceToStaging(source, container), { code: 'WORKSPACE_COPY_UNVERIFIED' })
  assert.equal(changed, true)
  assert.deepEqual(await fs.readdir(outside), ['canary'])
  assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'must not change')
  const staged = replace === 'source' ? path.join(container, 'tree') : path.join(retained, 'tree')
  assert.equal(await fs.readFile(path.join(staged, '.git/config'), 'utf8'), '[core]\n')
  const original = replace === 'source' ? retained : source
  assert.equal(await fs.readFile(path.join(original, '.git/config'), 'utf8'), '[core]\n')
})


test('oversized macOS resource-fork metadata is rejected before staging without allocating an unbounded snapshot', { skip: process.platform !== 'darwin' }, async t => {
  const { source, container } = await fixture(t), file = path.join(source, 'file')
  await fs.writeFile(file + '/..namedfork/rsrc', Buffer.alloc(17 * 1024 * 1024, 7))
  await assert.rejects(copyWorkspaceToStaging(source, container), { code: 'CRABOT_FILE_METADATA' })
  await assert.rejects(fs.stat(container), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(file), Buffer.from([0, 255, 7]))
})

test('POSIX Native directory operations reject malformed descriptors before changing cwd or timestamps', { skip: process.platform === 'win32' }, async t => {
  const native = (await import('../process-identity.cjs')).default, cwd = process.cwd()
  for (const fd of [-1, 0.5, NaN, Infinity, '3']) {
    assert.throws(() => native.enterDirectoryFd(fd, '0', '0'), { code: 'CRABOT_DIRECTORY_FD' })
    assert.throws(() => native.copyDirectoryTimesFd(fd, fd), { code: 'CRABOT_DIRECTORY_TIMES' })
  }
  assert.equal(process.cwd(), cwd)
})

test('POSIX copy ignores unrelated tool options inherited from the user environment', { skip: process.platform === 'win32' }, async t => {
  const { source, container } = await fixture(t), old = process.env.TAR_OPTIONS
  process.env.TAR_OPTIONS = '--crabot-not-an-option'
  try {
    const result = await copyWorkspaceToStaging(source, container)
    assert.equal(await fs.readFile(path.join(result.target, '.git/config'), 'utf8'), '[core]\n')
  } finally { if (old === undefined) delete process.env.TAR_OPTIONS; else process.env.TAR_OPTIONS = old }
})


test('bounded runner snapshots only the explicit OS copy success codes while keeping the default strict', async () => {
  const successCodes = [1], running = runBounded(process.execPath, ['-e', 'setTimeout(()=>process.exit(1),50)'], { successCodes })
  successCodes.length = 0; await running
  await assert.rejects(runBounded(process.execPath, ['-e', 'process.exit(8)'], { successCodes: [0, 1, 2, 3, 4, 5, 6, 7] }))
})

test('actual Windows copy retains named-stream bytes and read-only file attributes', { skip: process.platform !== 'win32' }, async t => {
  const { source, container } = await fixture(t), file = path.join(source, 'file')
  await fs.writeFile(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n')
  await fs.chmod(file, 0o444)
  const result = await copyWorkspaceToStaging(source, container), copied = path.join(result.target, 'file')
  assert.equal(await fs.readFile(copied + ':Zone.Identifier', 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\n')
  assert.equal((await fs.stat(copied)).mode & 0o200, 0)
  assert.deepEqual(await fs.readFile(file), Buffer.from([0, 255, 7]))
})

test('Windows copy holds source, container and payload identities through metadata verification', { skip: process.platform !== 'win32' }, async t => {
  const { root, source, container } = await fixture(t), native = (await import('../process-identity.cjs')).default
  const copy = native.copyPinnedWorkspaceMetadata; let observed = false
  t.mock.method(native, 'copyPinnedWorkspaceMetadata', (...args) => {
    observed = true
    for (const directory of [source, container, path.join(container, 'tree')]) {
      assert.throws(() => native.renameDirectoryNoReplace(directory, path.join(root, 'unexpected-move')), { code: 'CRABOT_DIRECTORY_MOVE' })
    }
    return copy(...args)
  })
  await copyWorkspaceToStaging(source, container)
  assert.equal(observed, true)
  await fs.rename(container, path.join(root, 'released-stage'))
})

test('Windows failed tool launch releases every directory lock and retains original and staged directories', { skip: process.platform !== 'win32' }, async t => {
  const { root, source, container } = await fixture(t), old = process.env.SystemRoot
  process.env.SystemRoot = path.join(root, 'missing-system')
  try { await assert.rejects(copyWorkspaceToStaging(source, container), { code: 'ENOENT' }) }
  finally { if (old === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = old }
  assert.deepEqual(await fs.readFile(path.join(source, 'file')), Buffer.from([0, 255, 7]))
  assert.deepEqual(await fs.readdir(path.join(container, 'tree')), [])
  await fs.rename(source, path.join(root, 'released-source')); await fs.rename(container, path.join(root, 'released-stage'))
})


test('cancelling after real gated tool registration never requests permission or writes target bytes', { skip: process.platform === 'win32' }, async t => {
  const { source, container } = await fixture(t)
  const result = path.join(container, 'result.json'), copier = new URL('../workspace-posix-copy.mjs', import.meta.url).href
  const nativeModule = new URL('../process-identity.cjs', import.meta.url).href, exits = new URL('../known-process-exit.cjs', import.meta.url).href
  const code = `import fs from 'node:fs';import native from ${JSON.stringify(nativeModule)};import exit from ${JSON.stringify(exits)};import {copyWorkspaceTreeFd} from ${JSON.stringify(copier)};
    const source=${JSON.stringify(source)},container=${JSON.stringify(container)},tree=container+'/tree';native.createPrivateStagingDirectory(container);fs.mkdirSync(tree,{mode:0o700});
    const fds=[source,tree,container].map(directory=>fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW));const controller=new AbortController();let tools,permitted=false,completed=false,code;
    try{await copyWorkspaceTreeFd(...fds,{signal:controller.signal,journal:{register:async value=>{tools=value;controller.abort();return{dispatch:'dispatch'}},permit:async()=>{permitted=true;return{dispatch:'dispatch'}},complete:async()=>{completed=exit.probeKnownProcessExit(tools.map(item=>item.process)).state==='stopped';return{dispatch:'dispatch'}}}})}catch(error){code=error.code}finally{for(const fd of fds)fs.closeSync(fd)}
    fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({permitted,completed,code,entries:fs.readdirSync(tree)}));`
  await runBounded(process.execPath, ['--input-type=module', '-e', code])
  const observed = JSON.parse(await fs.readFile(result, 'utf8'))
  assert.deepEqual(observed, { permitted: false, completed: true, code: 'WORKSPACE_COPY_UNVERIFIED', entries: [] })
  assert.equal(await fs.readFile(path.join(source, '.git/config'), 'utf8'), '[core]\n')
})
