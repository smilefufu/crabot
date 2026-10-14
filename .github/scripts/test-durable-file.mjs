import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] || fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const { durableAtomicWriteFile, durableRename, durableRemoveFile } = require(join(root, 'crabot-admin/dist/durable-file.js'))
const { ModuleManager } = require(join(root, 'crabot-core/dist/index.js'))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const ioError = Object.assign(new Error('injected genuine I/O failure'), { code: 'EPERM' })
const record = { schema_version: 1, completed: true, completed_at: new Date().toISOString(), admin_archive_fingerprint: 'fixture', admin_archived_record_count: 0, mm_archived_module_ids: [], process_trees_confirmed_stopped: true }

for (const owner of ['Admin', 'MM']) {
  for (const failure of [null, 'mkdir', 'file-sync', 'rename', 'directory-sync']) {
    test(`${owner}: ${failure || 'Windows atomic write without directory fsync'}`, async () => {
      const directory = await fsp.mkdtemp(join(tmpdir(), 'crabot-durable-'))
      const target = owner === 'Admin' ? join(directory, 'config.json') : join(directory, 'migrations/core-agent-singleton-v1.json')
      await fsp.mkdir(join(directory, 'migrations'))
      await fsp.writeFile(target, 'previous-content')
      const operations = []
      const originals = { open: fsp.open, rename: fsp.rename, mkdir: fsp.mkdir, openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, mkdirSync: fs.mkdirSync }
      const kinds = new Map()
      Object.defineProperty(process, 'platform', { value: failure === 'directory-sync' ? 'linux' : 'win32' })
      fsp.open = async (...args) => {
        const kind = args[1] === 'r' ? 'directory' : 'file'
        operations.push(`open-${kind}`)
        const handle = await originals.open(...args)
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          operations.push(`sync-${kind}`)
          if (failure === `${kind}-sync` || kind === 'directory') throw ioError
          return sync()
        }
        return handle
      }
      fsp.rename = async (...args) => { operations.push('rename'); if (failure === 'rename') throw ioError; return originals.rename(...args) }
      fsp.mkdir = async (...args) => { if (failure === 'mkdir') throw ioError; return originals.mkdir(...args) }
      fs.openSync = (...args) => { const kind = args[1] === 'r' ? 'directory' : 'file'; const fd = originals.openSync(...args); kinds.set(fd, kind); operations.push(`open-${kind}`); return fd }
      fs.fsyncSync = fd => { const kind = kinds.get(fd); operations.push(`sync-${kind}`); if (failure === `${kind}-sync` || kind === 'directory') throw ioError; return originals.fsyncSync(fd) }
      fs.renameSync = (...args) => { operations.push('rename'); if (failure === 'rename') throw ioError; return originals.renameSync(...args) }
      fs.mkdirSync = (...args) => { if (failure === 'mkdir') throw ioError; return originals.mkdirSync(...args) }
      try {
        const write = () => owner === 'Admin'
          ? durableAtomicWriteFile(target, JSON.stringify(record))
          : ModuleManager.prototype.saveCutoverRecord.call({ dataDir: directory }, record)
        if (failure) await assert.rejects(async () => write(), error => error === ioError)
        else await write()
        if (failure === 'directory-sync' || !failure) {
          assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), record)
          assert(operations.indexOf('sync-file') < operations.indexOf('rename'))
          assert.equal(operations.filter(op => op === 'sync-file').length, 1)
          assert.equal(operations.includes('sync-directory'), failure === 'directory-sync')
        } else {
          assert.equal(await fsp.readFile(target, 'utf8'), 'previous-content')
          if (failure === 'file-sync') assert(!operations.includes('rename'))
        }
      } finally {
        Object.assign(fsp, { open: originals.open, rename: originals.rename, mkdir: originals.mkdir })
        Object.assign(fs, { openSync: originals.openSync, fsyncSync: originals.fsyncSync, renameSync: originals.renameSync, mkdirSync: originals.mkdirSync })
        Object.defineProperty(process, 'platform', platform)
        await fsp.rm(directory, { recursive: true, force: true })
      }
    })
  }
}

test('Admin Windows rename and remove preserve real filesystem errors', async () => {
  const directory = await fsp.mkdtemp(join(tmpdir(), 'crabot-durable-'))
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const source = join(directory, 'source')
    const target = join(directory, 'target')
    await fsp.writeFile(source, 'content')
    await durableRename(source, target)
    assert.equal(await fsp.readFile(target, 'utf8'), 'content')
    await durableRemoveFile(target)
    assert(!fs.existsSync(target))
    await assert.rejects(durableRename(source, target), { code: 'ENOENT' })
    await assert.rejects(durableRemoveFile(directory), error => ['EPERM', 'EISDIR', 'ERR_FS_EISDIR'].includes(error.code))
  } finally {
    Object.defineProperty(process, 'platform', platform)
    await fsp.rm(directory, { recursive: true, force: true })
  }
})
