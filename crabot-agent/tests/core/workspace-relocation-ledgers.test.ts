import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { fstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { captureWorkspaceRelocationLedgers } from '../../src/core/workspace-relocation-ledgers.js'
import { prepareWorkspaceRelocationWorkerClosure } from '../../src/workers/harness/workspace-relocation-close.js'
import { captureWorkspaceRelocationWorkers } from '../../src/workers/harness/workspace-relocation-scope.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import { managerKeyToFilename } from '../../src/workers/harness/ledger-store.js'
const native = require('../../../scripts/lib/process-identity.cjs')
const key = 'channel::session' as const
const windowsAlias = process.platform === 'win32' && realpathSync(tmpdir()) !== realpathSync.native(tmpdir())

describe('Agent-only read-only relocation ledger capture', () => {
  let root: string, data: string, directory: string, file: string
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-offline-ledgers-')))
    data = path.join(root, 'data')
    if (process.platform === 'win32') native.createPrivateDirectory(data)
    else await fs.mkdir(data, { mode: 0o700 })
    directory = path.join(data, 'agent/worker-ledgers'); await fs.mkdir(directory, { recursive: true })
    file = path.join(directory, managerKeyToFilename(key))
    await fs.writeFile(file, '{"manager_key":"channel::session","workers":[]}\n', { mode: 0o600 })
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })

  it.skipIf(process.platform === 'win32')('reads a legacy 0755 data root without changing its permissions', async () => {
    await fs.chmod(data, 0o755)
    const before = await fs.readFile(file)
    const snapshot = await captureWorkspaceRelocationLedgers(data)
    expect(snapshot.files).toHaveLength(1)
    expect(await fs.readFile(file)).toEqual(before)
    expect((await fs.stat(data)).mode & 0o777).toBe(0o755)
  })

  it.skipIf(process.platform === 'win32').each([0o775, 0o777, 0o500])('refuses an unsafe existing data root without changing mode %s', async mode => {
    try {
      await fs.chmod(data, mode)
      await expect(captureWorkspaceRelocationLedgers(data)).rejects.toThrow()
      expect((await fs.stat(data)).mode & 0o777).toBe(mode)
    } finally { await fs.chmod(data, 0o700) }
  })

  it('captures exact bytes and canonical owners without reading old backups, temporary data or the workspace', async () => {
    await fs.writeFile(path.join(directory, '.tmp-12345678-1234-4123-8123-123456789abc.json'), 'unfinished legacy temp')
    await fs.writeFile(path.join(directory, 'old.json.pre-request-fixture.bak'), 'preserve legacy backup')
    await fs.mkdir(path.join(data, 'workspaces'))
    const read = vi.spyOn(fs, 'open')
    const snapshot = await captureWorkspaceRelocationLedgers(data)
    expect(snapshot.files.map(row => row.manager_key)).toEqual([key])
    expect(snapshot.files[0].contents).toBe(await fs.readFile(file, 'utf8'))
    expect(read.mock.calls.map(args => args[0])).toEqual([file])
    expect(snapshot.names).toContain('.tmp-12345678-1234-4123-8123-123456789abc.json')
    expect(await fs.readFile(path.join(directory, 'old.json.pre-request-fixture.bak'), 'utf8')).toBe('preserve legacy backup')
    expect(Object.isFrozen(snapshot.files[0])).toBe(true)
  })
  it('feeds the exact physical capture into Agent closure without touching the original ledger', async () => {
    const worker: LedgerWorker = { worker_id: 'native-task', manager_key: key, task: { id: 'original-task', title: 'keep original goal', status: 'queued', created_at: '2026-10-20T00:00:00.000Z' },
      origin: { trigger_type: 'scheduled' }, report_to: { channel_id: 'channel', session_id: 'session' }, incarnations: [], updated_at: '2026-10-20T00:00:00.000Z' }
    const contents = JSON.stringify({ manager_key: key, workers: [worker] }, null, 4) + '\n'
    await fs.writeFile(file, contents)
    const snapshot = await captureWorkspaceRelocationLedgers(data)
    const [prepared] = prepareWorkspaceRelocationWorkerClosure({ intentId: '12345678-1234-4123-8123-123456789abc', closedAt: '2026-10-21T01:00:00.000Z',
      workers: captureWorkspaceRelocationWorkers([{ managerKey: key, worker }]), ledgers: snapshot.files })
    expect(JSON.parse(prepared.contents).workers[0]).toMatchObject({ origin: worker.origin, report_to: worker.report_to,
      task: { id: worker.task.id, title: worker.task.title, status: 'closed', closed: { by: 'migration' } } })
    expect(await fs.readFile(file, 'utf8')).toBe(contents)
  })
  it.runIf(windowsAlias)('keeps an existing CLI binding for a real Windows short path to the same native directory', async () => {
    const alias = path.join(tmpdir(), path.basename(root), 'data')
    expect(realpathSync(alias)).not.toBe(await fs.realpath(alias))
    expect(native.inspectDirectoryFileId(alias)).toBe(native.inspectDirectoryFileId(data))
    const snapshot = await captureWorkspaceRelocationLedgers(alias)
    expect(snapshot.data_root).toBe(realpathSync(alias))
    expect(snapshot.files[0].contents).toBe(await fs.readFile(file, 'utf8'))
  })
  it.each(['data', 'agent', 'ledgers'])('does not create a missing %s namespace', async part => {
    const missing = part === 'data' ? data : part === 'agent' ? path.join(data, 'agent') : directory
    await fs.rm(missing, { recursive: true })
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toThrow()
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a noncanonical JSON ledger rather than hiding it from the complete scope', async () => {
    await fs.writeFile(path.join(directory, 'unindexed.json'), '{}')
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_LEDGER_CAPTURE', stage: 'file-name' })
  })
  it('rejects hard-linked ledger data without changing the external link', async () => {
    const outside = path.join(root, 'outside'); await fs.link(file, outside)
    const original = await fs.readFile(outside)
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toThrow()
    expect(await fs.readFile(outside)).toEqual(original)
  })
  it.skipIf(process.platform === 'win32')('rejects symlink directories, symlink files, and FIFO without following or blocking', async () => {
    const saved = file + '.original'; await fs.rename(file, saved); await fs.symlink(saved, file)
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toThrow()
    await fs.unlink(file); execFileSync('mkfifo', [file])
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toThrow()
    await fs.unlink(file); await fs.rename(saved, file)
    const original = directory + '-original'; await fs.rename(directory, original); await fs.symlink(original, directory)
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toThrow()
  })
  it.skipIf(process.platform === 'win32')('rejects group-writable data instead of changing permissions', async () => {
    await fs.chmod(file, 0o620)
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toThrow()
    expect((await fs.stat(file)).mode & 0o777).toBe(0o620)
  })
  it('rejects an over-budget sparse file before opening a body handle', async () => {
    await fs.truncate(file, 64 * 1024 * 1024 + 1)
    const opened = vi.spyOn(fs, 'open')
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toThrow('64 MiB')
    expect(opened).not.toHaveBeenCalled()
  })
  it.each(['replace', 'mutate', 'new file', 'cancel'])('rejects %s during a real read and closes its descriptor', async mode => {
    const open = fs.open.bind(fs); let descriptor: number | undefined, changed = false
    const controller = new AbortController()
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args); descriptor = handle.fd
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
        const result = await (read as any)(...readArgs)
        if (!changed) {
          changed = true
          if (mode === 'replace') { await fs.rename(file, file + '.old'); await fs.writeFile(file, 'replacement') }
          if (mode === 'mutate') await fs.writeFile(file, 'same file changed during capture')
          if (mode === 'new file') await fs.writeFile(path.join(directory, managerKeyToFilename('new::session')), '{}')
          if (mode === 'cancel') controller.abort()
        }
        return result
      })
      return handle
    })
    const capture = captureWorkspaceRelocationLedgers(data, { signal: controller.signal })
    if (mode === 'cancel') await expect(capture).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_LEDGER_CAPTURE', stage: 'capture-aborted' })
    else await expect(capture).rejects.toThrow()
    expect(changed).toBe(true); expect(descriptor).toBeDefined()
    expect(() => fstatSync(descriptor!)).toThrow()
  })
  it.each(['shorten', 'append'])('identifies %s during physical capture and closes its descriptor', async mode => {
    const original = Buffer.alloc(256 * 1024, 32)
    await fs.writeFile(file, original)
    const open = fs.open.bind(fs); let descriptor: number | undefined, changed = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args); descriptor = handle.fd
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
        const result = await (read as any)(...readArgs)
        if (!changed) {
          changed = true
          if (mode === 'shorten') await fs.truncate(file, 0)
          else await fs.appendFile(file, 'additional bytes')
        }
        return result
      })
      return handle
    })
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_LEDGER_CAPTURE',
      stage: mode === 'shorten' ? 'file-short-read' : 'file-extra-byte' })
    expect(changed).toBe(true); expect(descriptor).toBeDefined()
    expect(() => fstatSync(descriptor!)).toThrow()
    expect(await fs.readFile(file)).toEqual(mode === 'shorten' ? Buffer.alloc(0) : Buffer.concat([original, Buffer.from('additional bytes')]))
  })
  it.runIf(process.platform === 'win32')('pins the actual namespace and its ancestors while reading, then releases every pin', async () => {
    const open = fs.open.bind(fs); let checked = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args), read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
        if (!checked) {
          checked = true
          await expect(fs.rename(directory, directory + '-moved')).rejects.toThrow()
          await expect(fs.rename(path.dirname(directory), path.dirname(directory) + '-moved')).rejects.toThrow()
        }
        return (read as any)(...readArgs)
      })
      return handle
    })
    await captureWorkspaceRelocationLedgers(data)
    expect(checked).toBe(true)
    await fs.rename(directory, directory + '-released')
    expect((await fs.stat(directory + '-released')).isDirectory()).toBe(true)
  })
  it('rejects invalid UTF-8 rather than silently replacing the original bytes', async () => {
    await fs.writeFile(file, Buffer.from([123, 34, 255, 34, 58, 49, 125]))
    await expect(captureWorkspaceRelocationLedgers(data)).rejects.toThrow()
  })
})
