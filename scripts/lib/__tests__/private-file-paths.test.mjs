import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import identity from '../process-identity.cjs'

test('Windows private file adapter preserves payload and converts actual filesystem paths only', () => {
  const calls = [], method = name => (...args) => { calls.push([name, ...args]); return true }
  const native = Object.fromEntries(['writePrivateFile', 'isPrivateFile', 'isOwnedFile', 'createPrivateDirectory', 'isPrivateDirectory', 'isOwnedDirectory', 'isOwnerOnlyFile', 'isOwnerOnlyDirectory', 'isExistingDataDirectory'].map(name => [name, method(name)]))
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(new URL('../process-identity.cjs', import.meta.url), 'utf8'), {
    module, process: { platform: 'win32' }, require: name => name === 'node:path' ? path.win32 : name === 'node:fs' ? fs : native,
  })
  for (const file of ['C:/deep/中文/file.json', '\\\\server\\share\\中文\\file.json', 'C:\\deep\\' + 'long-name/'.repeat(30) + 'file.json']) {
    const expected = path.win32.toNamespacedPath(file)
    for (const name of Object.keys(native)) {
      const args = name === 'writePrivateFile' ? [file, 'original body\n'] : [file]
      assert.equal(module.exports[name](...args), true)
      assert.deepEqual(calls.pop(), [name, expected, ...args.slice(1)])
    }
  }
})

test('Windows native private ACL operations support deep Unicode paths without overwriting existing objects', { skip: process.platform !== 'win32' }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-private-path-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const parent = path.join(root, ...Array.from({ length: 24 }, (_, index) => 'directory-' + index + '-中文'))
  fs.mkdirSync(parent, { recursive: true })
  const directory = path.join(parent, 'private'), file = path.join(directory, '原始文件.json')
  assert.ok(directory.length > 300)
  identity.createPrivateDirectory(directory)
  assert.equal(identity.isOwnedDirectory(directory), true)
  assert.equal(identity.isPrivateDirectory(directory), true)
  const before = fs.statSync(directory, { bigint: true })
  assert.throws(() => identity.createPrivateDirectory(directory), { code: 'CRABOT_PRIVATE_DIRECTORY' })
  assert.equal(fs.statSync(directory, { bigint: true }).ino, before.ino)
  identity.writePrivateFile(file, 'original body\n')
  assert.equal(identity.isOwnedFile(file), true)
  assert.equal(identity.isPrivateFile(file), true)
  assert.equal(identity.isPrivateFile(path.toNamespacedPath(file)), true)
  assert.equal(identity.isPrivateFile(path.relative(process.cwd(), file)), true)
  assert.throws(() => identity.writePrivateFile(file, 'replacement'), { code: 'CRABOT_PRIVATE_FILE' })
  assert.equal(fs.readFileSync(file, 'utf8'), 'original body\n')
})

test('Windows repeated private ACL reads observe access changes without changing the original owner or files', { skip: process.platform !== 'win32' }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-private-acl-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'private'), file = path.join(directory, 'original.json')
  identity.createPrivateDirectory(directory); identity.writePrivateFile(file, 'retained original body')
  const fileBefore = fs.statSync(file, { bigint: true }), directoryBefore = fs.statSync(directory, { bigint: true })
  const started = performance.now()
  for (let index = 0; index < 256; index++) {
    assert.equal(identity.isPrivateFile(file), true); assert.equal(identity.isPrivateDirectory(directory), true)
    assert.equal(identity.isOwnedFile(file), true); assert.equal(identity.isOwnedDirectory(directory), true)
  }
  t.diagnostic('1024 fresh private/owner ACL reads: ' + Math.round(performance.now() - started) + 'ms')
  const icacls = path.join(process.env.SystemRoot, 'System32/icacls.exe')
  for (const target of [file, directory]) {
    execFileSync(icacls, [target, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe' })
    assert.equal(target === file ? identity.isPrivateFile(target) : identity.isPrivateDirectory(target), false)
    assert.equal(target === file ? identity.isOwnedFile(target) : identity.isOwnedDirectory(target), true)
    execFileSync(icacls, [target, '/remove:g', '*S-1-1-0'], { stdio: 'pipe' })
    assert.equal(target === file ? identity.isPrivateFile(target) : identity.isPrivateDirectory(target), true)
  }
  assert.equal(fs.statSync(file, { bigint: true }).ino, fileBefore.ino)
  assert.equal(fs.statSync(directory, { bigint: true }).ino, directoryBefore.ino)
  assert.equal(fs.readFileSync(file, 'utf8'), 'retained original body')
})


test('Windows runtime registry inheritance remains owner-only without changing protected coordinator ACL rules', { skip: process.platform !== 'win32' }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-inherited-acl-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const data = path.join(root, 'data'); identity.createPrivateDirectory(data)
  const registry = path.join(data, 'module-runtime-registry'), records = path.join(registry, 'records')
  fs.mkdirSync(records, { recursive: true })
  const file = path.join(records, 'finite-runtime.json'); fs.writeFileSync(file, 'retained runtime bytes')
  assert.equal(identity.isPrivateDirectory(data), true)
  assert.equal(identity.isPrivateDirectory(registry), false)
  assert.equal(identity.isPrivateFile(file), false)
  const before = fs.statSync(file, { bigint: true })
  assert.equal(identity.isOwnerOnlyDirectory(data), true)
  assert.equal(identity.isOwnerOnlyDirectory(registry), true)
  assert.equal(identity.isOwnerOnlyDirectory(records), true)
  assert.equal(identity.isOwnerOnlyFile(file), true)
  const icacls = path.join(process.env.SystemRoot, 'System32/icacls.exe')
  for (const target of [file, registry]) {
    const inspect = target === file ? identity.isOwnerOnlyFile : identity.isOwnerOnlyDirectory
    execFileSync(icacls, [target, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe' })
    assert.equal(inspect(target), false)
    assert.equal(target === file ? identity.isOwnedFile(target) : identity.isOwnedDirectory(target), true)
    // Restore this fixture's original default inheritance from its owner-only parent.
    execFileSync(icacls, [target, '/reset'], { stdio: 'pipe' })
    assert.equal(inspect(target), true)
  }
  const junction = path.join(root, 'junction'); fs.symlinkSync(records, junction, 'junction')
  assert.throws(() => identity.isOwnerOnlyDirectory(junction), { code: 'CRABOT_PRIVATE_FILE' })
  assert.equal(fs.statSync(file, { bigint: true }).ino, before.ino)
  assert.equal(fs.readFileSync(file, 'utf8'), 'retained runtime bytes')
  assert.equal(identity.isPrivateDirectory(registry), false)
  assert.equal(identity.isPrivateFile(file), false)
})

test('Windows existing app data keeps inherited/readable ACLs but rejects other ordinary writers', { skip: process.platform !== 'win32' }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-existing-access-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const data = path.join(root, 'data'); identity.createPrivateDirectory(data)
  const inherited = path.join(data, 'inherited'); fs.mkdirSync(inherited)
  const file = path.join(inherited, 'retained.txt'); fs.writeFileSync(file, 'old project bytes')
  const before = fs.statSync(inherited, { bigint: true })
  const icacls = path.join(process.env.SystemRoot, 'System32/icacls.exe')
  assert.equal(identity.isPrivateDirectory(inherited), false)
  assert.equal(identity.isExistingDataDirectory(inherited), true)
  for (const sid of ['S-1-5-18', 'S-1-5-32-544']) execFileSync(icacls, [inherited, '/grant', '*' + sid + ':(OI)(CI)(F)'], { stdio: 'pipe' })
  execFileSync(icacls, [inherited, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe' })
  const acl = execFileSync(icacls, [inherited], { encoding: 'utf8' })
  assert.equal(identity.isExistingDataDirectory(inherited), true)
  assert.equal(identity.isPrivateDirectory(inherited), false, 'private control factory remains strict')
  assert.equal(execFileSync(icacls, [inherited], { encoding: 'utf8' }), acl, 'observation never changes the old ACL')
  execFileSync(icacls, [inherited, '/grant', '*S-1-1-0:(W)'], { stdio: 'pipe' })
  assert.equal(identity.isExistingDataDirectory(inherited), false)
  execFileSync(icacls, [inherited, '/remove:g', '*S-1-1-0'], { stdio: 'pipe' })
  assert.equal(identity.isExistingDataDirectory(inherited), true)
  const link = path.join(root, 'link'); fs.symlinkSync(inherited, link, 'junction')
  assert.throws(() => identity.isExistingDataDirectory(link), { code: 'CRABOT_PRIVATE_FILE' })
  assert.equal(fs.statSync(inherited, { bigint: true }).ino, before.ino)
  assert.equal(fs.readFileSync(file, 'utf8'), 'old project bytes')
})

test('Windows ordinary existing paths remain manageable without changing their security descriptors', { skip: process.platform !== 'win32' }, t => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-default-owner-')))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'legacy'), data = path.join(root, 'data'), file = path.join(root, 'VERSION')
  fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(file, 'old release bytes')
  const original = new Map([root, data, file].map(target => [target, identity.inspectFileMetadata(target)]))
  const administratorsOwned = original.get(root).owner === 'S-1-5-32-544'
  t.diagnostic('ordinary default Administrators owner: ' + administratorsOwned)
  for (const directory of [root, data]) {
    assert.equal(identity.isOwnedDirectory(directory), true)
    assert.equal(identity.isExistingDataDirectory(directory), true)
    assert.equal(identity.isPrivateDirectory(directory), false)
  }
  assert.equal(identity.isOwnedFile(file), true)
  assert.equal(identity.isPrivateFile(file), false)
  for (const [target, before] of original) assert.deepEqual(identity.inspectFileMetadata(target), before)
  assert.equal(fs.readFileSync(file, 'utf8'), 'old release bytes')
  const control = path.join(root, 'private-control.json'); identity.writePrivateFile(control, '{}')
  assert.equal(identity.isPrivateFile(control), true)
  const icacls = path.join(process.env.SystemRoot, 'System32/icacls.exe')
  execFileSync(icacls, [root, '/grant', '*S-1-1-0:(W)'], { stdio: 'pipe' })
  assert.equal(identity.isExistingDataDirectory(root), false)
  if (administratorsOwned) assert.equal(identity.isOwnedDirectory(root), false)
})
