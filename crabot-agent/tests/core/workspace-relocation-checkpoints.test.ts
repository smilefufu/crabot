import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { archiveWorkspaceRelocationCheckpoint } from '../../src/core/workspace-relocation-checkpoints.js'
import { digest, version } from '../../src/core/workspace-maintenance-files.js'
import { encodeSegment } from '../../src/workers/harness/ledger-store.js'
const native = require('../../../scripts/lib/process-identity.cjs')
const id = '12345678-1234-4123-8123-123456789abc', key = 'channel::original', requestId = '1'.repeat(64)

for (const kind of ['manager', 'request'] as const) describe('fixed ' + kind + ' checkpoint archival without business startup', () => {
  let root: string, data: string, manager: string, source: string, archive: string, original: Buffer, options: any
  beforeEach(async () => {
    root = realpathSync(await fs.mkdtemp(path.join(tmpdir(), 'crabot-checkpoint-archive-'))); data = path.join(root, 'data')
    if (process.platform === 'win32') native.createPrivateDirectory(data)
    else await fs.mkdir(data, { mode: 0o700 })
    manager = kind === 'manager' ? path.join(data, 'agent/managers', encodeSegment(key))
      : path.join(data, 'agent/conversation-requests', requestId, 'session', encodeSegment(key))
    await fs.mkdir(manager, { recursive: true })
    source = path.join(manager, 'running.json'); archive = path.join(manager, 'workspace-relocation-history', id)
    original = Buffer.from(JSON.stringify({ episodeId: 'original-episode', state: { key, recent: [{ role: 'user', content: 'original private input' }], foldedCount: 0 },
      envelopes: [], wakeIndex: -1, pending: [], hasEngineMessages: true, turns: [], responses: [], tools: [], pendingToolCallIds: ['unknown-operation'],
      adminChatClaims: [['original-admin-request', 'unclaimed']], transientMessageIds: [], spawnedWorkerIds: ['closed-old-worker'],
      execution: { successfulSendMessageTargets: [], continuedWorkers: [], needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0 } }, null, 4) + '\n')
    await fs.writeFile(source, original, { mode: 0o600 })
    options = { dataDir: data, id, managerKey: key, source: kind === 'manager' ? { kind } : { kind, requestId },
      beforeVersion: version(await fs.stat(source, { bigint: true })), beforeSha256: digest(original), verify: async () => {} }
  })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it.skipIf(process.platform === 'win32')('archives under a legacy 0755 data root while keeping private history', async () => {
    await fs.chmod(data, 0o755)
    const result = await archiveWorkspaceRelocationCheckpoint(options)
    expect(result.dispatch).toBe('dispatch')
    expect(await fs.readFile(path.join(archive, 'checkpoint.json'))).toEqual(original)
    expect((await fs.stat(data)).mode & 0o777).toBe(0o755)
    expect((await fs.stat(archive)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(archive, 'checkpoint.json'))).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32').each([0o775, 0o777, 0o500])('refuses an unsafe existing data root without changing mode %s', async mode => {
    try {
      await fs.chmod(data, mode)
      await expect(archiveWorkspaceRelocationCheckpoint(options)).rejects.toThrow()
      expect((await fs.stat(data)).mode & 0o777).toBe(mode)
    } finally { await fs.chmod(data, 0o700) }
  })

  it('preserves raw history and unknown results while removing only the bound active checkpoint', async () => {
    const first = await archiveWorkspaceRelocationCheckpoint(options)
    expect(first.dispatch).toBe('dispatch')
    expect(await fs.readFile(path.join(archive, 'checkpoint.json'))).toEqual(original)
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })
    const metadata = await fs.readFile(path.join(archive, 'manifest.json'), 'utf8')
    expect(metadata).not.toContain('original private input'); expect(metadata).not.toContain('unknown-operation')
    const stat = await fs.stat(path.join(archive, 'checkpoint.json'), { bigint: true })
    expect(await archiveWorkspaceRelocationCheckpoint(options)).toEqual({ ...first, dispatch: 'observe' })
    expect(version(await fs.stat(path.join(archive, 'checkpoint.json'), { bigint: true }))).toBe(version(stat))
    expect(await fs.readdir(archive)).toEqual(expect.arrayContaining(['manifest.json', 'checkpoint.json', 'complete.json']))
    await expect(fs.lstat(path.join(data, 'workspace-control'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  for (const change of ['body', 'completion', 'directory', 'active source']) it('rechecks retained archival evidence before common completion: ' + change, async () => {
    let check: (() => void) | undefined
    await archiveWorkspaceRelocationCheckpoint({ ...options, retainVerification: (verify: () => void) => { check = verify } })
    expect(check).toBeTypeOf('function'); expect(() => check!()).not.toThrow()
    if (change === 'body') await fs.writeFile(path.join(archive, 'checkpoint.json'), 'changed')
    if (change === 'completion') await fs.writeFile(path.join(archive, 'complete.json'), 'null')
    if (change === 'directory') { await fs.rename(archive, archive + '-kept'); await fs.mkdir(archive) }
    if (change === 'active source') await fs.writeFile(source, original, { mode: 0o600 })
    expect(() => check!()).toThrow()
  })
  it('read-only completion observation never creates an archive for an active original checkpoint', async () => {
    await expect(archiveWorkspaceRelocationCheckpoint({ ...options, requireComplete: true })).rejects.toThrow()
    expect(await fs.readFile(source)).toEqual(original)
    await expect(fs.lstat(path.dirname(archive))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('read-only completion observation does not repair a missing completion receipt', async () => {
    await archiveWorkspaceRelocationCheckpoint(options)
    await fs.unlink(path.join(archive, 'complete.json'))
    await expect(archiveWorkspaceRelocationCheckpoint({ ...options, requireComplete: true })).rejects.toThrow()
    await expect(fs.lstat(path.join(archive, 'complete.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(archive, 'checkpoint.json'))).toEqual(original)
  })
  it('read-only completion observation preserves the same completed archive', async () => {
    const result = await archiveWorkspaceRelocationCheckpoint(options), stat = await fs.stat(path.join(archive, 'checkpoint.json'), { bigint: true })
    expect(await archiveWorkspaceRelocationCheckpoint({ ...options, requireComplete: true })).toEqual({ ...result, dispatch: 'observe' })
    expect(version(await fs.stat(path.join(archive, 'checkpoint.json'), { bigint: true }))).toBe(version(stat))
  })
  it('requires fresh caller verification before creating any archive namespace', async () => {
    await expect(archiveWorkspaceRelocationCheckpoint({ ...options, verify: async () => { throw new Error('unavailable original role') } })).rejects.toThrow()
    expect(await fs.readFile(source)).toEqual(original)
    await expect(fs.lstat(path.dirname(archive))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  for (const boundary of ['manifest', 'copy', 'unlink', 'complete']) it('retains the same history across interruption after ' + boundary, async () => {
    let interrupted = false
    const exists = (file: string) => fs.lstat(file).then(() => true, () => false)
    await expect(archiveWorkspaceRelocationCheckpoint({ ...options, verify: async () => {
      const ready = boundary === 'manifest' ? await exists(path.join(archive, 'manifest.json'))
        : boundary === 'copy' ? await fs.readFile(path.join(archive, 'checkpoint.json')).then(body => digest(body) === options.beforeSha256, () => false)
        : boundary === 'unlink' ? !await exists(source) : await exists(path.join(archive, 'complete.json'))
      if (ready && !interrupted) { interrupted = true; throw new Error('lost current verification') }
    } })).rejects.toThrow()
    expect(interrupted).toBe(true)
    await archiveWorkspaceRelocationCheckpoint(options)
    expect(await fs.readFile(path.join(archive, 'checkpoint.json'))).toEqual(original)
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a replaced active checkpoint and preserves its new contents', async () => {
    await fs.rename(source, source + '.kept'); await fs.writeFile(source, original, { mode: 0o600 })
    await expect(archiveWorkspaceRelocationCheckpoint(options)).rejects.toThrow()
    expect(await fs.readFile(source)).toEqual(original); expect(await fs.readFile(source + '.kept')).toEqual(original)
  })
  it('refuses an unbound existing archive directory', async () => {
    await fs.mkdir(archive, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(archive, 'unrelated'), 'preserve')
    await expect(archiveWorkspaceRelocationCheckpoint(options)).rejects.toThrow()
    expect(await fs.readFile(source)).toEqual(original); expect(await fs.readFile(path.join(archive, 'unrelated'), 'utf8')).toBe('preserve')
  })
  it('refuses missing source without a verified archived copy and never creates an empty replacement', async () => {
    await fs.unlink(source)
    await expect(archiveWorkspaceRelocationCheckpoint(options)).rejects.toThrow()
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(archive)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  const pauseAfterManifest = async (options: any, archive: string) => {
    await expect(archiveWorkspaceRelocationCheckpoint({ ...options, verify: async () => {
      if (await fs.lstat(path.join(archive, 'manifest.json')).then(() => true, () => false)) throw new Error('pause after manifest')
    } })).rejects.toThrow()
  }
  it('refuses a same-content replacement for the bound archive file', async () => {
    await pauseAfterManifest(options, archive)
    const target = path.join(archive, 'checkpoint.json'), retained = path.join(root, 'retained-copy')
    await fs.rename(target, retained); await fs.writeFile(target, original, { mode: 0o600 })
    await expect(archiveWorkspaceRelocationCheckpoint(options)).rejects.toThrow()
    expect(await fs.readFile(source)).toEqual(original); expect(await fs.readFile(target)).toEqual(original)
    expect(await fs.readFile(retained)).toEqual(Buffer.alloc(0))
  })
  for (const contents of ['null', 'false', '{}']) it('rejects damaged completion ' + contents + ' before any further copy or unlink', async () => {
    await pauseAfterManifest(options, archive)
    const complete = path.join(archive, 'complete.json'), target = path.join(archive, 'checkpoint.json')
    if (process.platform === 'win32') native.writePrivateFile(complete, contents)
    else await fs.writeFile(complete, contents, { mode: 0o600 })
    const before = version(await fs.stat(target, { bigint: true }))
    await expect(archiveWorkspaceRelocationCheckpoint(options)).rejects.toThrow()
    expect(await fs.readFile(source)).toEqual(original); expect(await fs.readFile(target)).toEqual(Buffer.alloc(0))
    expect(version(await fs.stat(target, { bigint: true }))).toBe(before)
  })
  it('rejects a foreign episode in an otherwise bound manifest before copying any body', async () => {
    await pauseAfterManifest(options, archive)
    const file = path.join(archive, 'manifest.json'), manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...manifest, episode_id: 'foreign-episode' }))
    await expect(archiveWorkspaceRelocationCheckpoint(options)).rejects.toThrow()
    expect(await fs.readFile(source)).toEqual(original)
    expect(await fs.readFile(path.join(archive, 'checkpoint.json'))).toEqual(Buffer.alloc(0))
  })
  it('does not remove a re-created active checkpoint after a completed archival', async () => {
    await archiveWorkspaceRelocationCheckpoint(options); await fs.writeFile(source, original, { mode: 0o600 })
    await expect(archiveWorkspaceRelocationCheckpoint(options)).rejects.toThrow()
    expect(await fs.readFile(source)).toEqual(original)
  })
})
