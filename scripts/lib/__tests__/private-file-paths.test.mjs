import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import identity from '../process-identity.cjs'

test('Windows private file adapter preserves payload and converts actual filesystem paths only', () => {
  const calls = [], method = name => (...args) => { calls.push([name, ...args]); return true }
  const native = Object.fromEntries(['writePrivateFile', 'isPrivateFile', 'isOwnedFile', 'createPrivateDirectory', 'isPrivateDirectory', 'isOwnedDirectory'].map(name => [name, method(name)]))
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
  const parent = path.join(root, ...Array.from({ length: 14 }, (_, index) => 'directory-' + index + '-中文'))
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
