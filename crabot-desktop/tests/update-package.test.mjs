import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { UpdateConfigSchema, UpdateInfoSchema, verifyUpdateDownload } from '../dist/update-package.js'

test('the release channel accepts only the fixed HTTPS origin and pinned-config fields', () => {
  const config = { provider: 'generic', url: 'https://github.com/smilefufu/crabot/releases/latest/download', updaterCacheDirName: 'crabot-updater' }
  assert.equal(UpdateConfigSchema.safeParse(config).success, true)
  for (const value of [{ ...config, url: 'http://github.com/smilefufu/crabot/releases/latest/download' },
    { ...config, url: 'https://example.com/releases' }, { ...config, verifyUpdateCodeSignature: false }, { ...config, publisherName: [] }]) {
    assert.equal(UpdateConfigSchema.safeParse(value).success, false)
  }
})
test('update metadata rejects traversal, credentials, arbitrary origins, absent digests and invalid sizes', () => {
  const file = { url: 'Crabot-1.2.4-arm64.zip', sha512: Buffer.alloc(64, 1).toString('base64'), size: 100 }
  const valid = files => UpdateInfoSchema.safeParse({ version: '1.2.4', files }).success
  assert.equal(valid([file]), true)
  for (const url of ['../update.zip', '/update.zip', 'https://example.com/update.zip', 'secret@update.zip', 'file:///update.zip', 'folder%2fupdate.zip']) {
    assert.equal(valid([{ ...file, url }]), false)
  }
  for (const value of [{ ...file, sha512: 'missing' }, { ...file, size: 0 }, { ...file, size: -1 }, { ...file, size: undefined }]) assert.equal(valid([value]), false)
})
test('download bytes are rechecked before installation; changed files, lengths and symbolic references fail', async t => {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 更新包 ')); t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const bytes = Buffer.from([0, 1, 255, 13, 10]), file = path.join(temporary, 'package.zip')
  await fs.writeFile(file, bytes)
  const update = { version: '1.2.4', file, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }
  await verifyUpdateDownload(update)
  await fs.writeFile(file, Buffer.from([1, 1, 255, 13, 10])); await assert.rejects(verifyUpdateDownload(update))
  await fs.writeFile(file, bytes); await assert.rejects(verifyUpdateDownload({ ...update, size: bytes.length + 1 }))
  if (process.platform !== 'win32') {
    const alias = path.join(temporary, 'alias.zip'); await fs.symlink('package.zip', alias)
    await assert.rejects(verifyUpdateDownload({ ...update, file: alias }))
  }
  await fs.rm(file)
  await assert.rejects(verifyUpdateDownload(update), { code: 'CRABOT_UPDATE_INTEGRITY' })
})
