import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { publishWorkspaceRelocationRetirements, WorkspaceRelocationRetirements } from '../../src/core/workspace-relocation-retirements.js'
const native = require('../../../scripts/lib/process-identity.cjs')
const id = '12345678-1234-4123-8123-123456789abc', key = 'channel::original', sha = '1'.repeat(64), nextSha = '2'.repeat(64)

describe('Agent-owned exact workspace migration recovery retirements', () => {
  let root: string, data: string, directory: string, plan: any
  beforeEach(async () => {
    root = realpathSync(await fs.mkdtemp(path.join(tmpdir(), 'crabot-retired-recovery-'))); data = path.join(root, 'data')
    if (process.platform === 'win32') native.createPrivateDirectory(data)
    else await fs.mkdir(data, { mode: 0o700 })
    await fs.mkdir(path.join(data, 'agent'))
    directory = path.join(data, 'agent/workspace-relocation-retirements')
    plan = { schema_version: 1, intent_id: id, file_ready_sha256: sha, worker_closure_sha256: nextSha, records: [
      { kind: 'request', manager_key: key, request_id: sha, source_sha256: nextSha },
      { kind: 'admin_chat', manager_key: key, request_id: 'original-admin-input', message_sha256: sha },
      { kind: 'voice', channel_id: 'voice-channel', turn_id: 'original-turn', payload_sha256: sha },
      { kind: 'workboard', manager_key: key, revision: 42 },
    ] }
  })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const publish = (dataDir: string, document: any, verify = async () => {}) => publishWorkspaceRelocationRetirements({ dataDir, document, verify })

  it('has no effect and creates no namespace when no migration exists', async () => {
    const store = new WorkspaceRelocationRetirements(data)
    expect(store.request(key, sha, nextSha)).toBe(false)
    expect(store.adminChat(key, 'original-admin-input', sha)).toBe(false)
    expect(store.voice('voice-channel', 'original-turn', sha)).toBe(false)
    expect(store.workboard(key, 42)).toBe(false)
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('persists original exact identities once and leaves all new work outside the retired set', async () => {
    const first = await publish(data, plan)
    expect(first.dispatch).toBe('dispatch')
    const file = path.join(directory, id + '.json'), before = await fs.stat(file, { bigint: true }), body = await fs.readFile(file)
    expect(await publish(data, plan)).toEqual({ ...first, dispatch: 'observe' })
    const after = await fs.stat(file, { bigint: true })
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs])
    expect(await fs.readFile(file)).toEqual(body)
    const store = new WorkspaceRelocationRetirements(data)
    expect(store.request(key, sha, nextSha)).toBe(true)
    expect(store.adminChat(key, 'original-admin-input', sha)).toBe(true)
    expect(store.voice('voice-channel', 'original-turn', sha)).toBe(true)
    expect(store.workboard(key, 42)).toBe(true)
    expect(store.request('other::conversation', sha, nextSha)).toBe(false)
    expect(store.request(key, nextSha, sha)).toBe(false)
    expect(store.adminChat(key, 'new-input', sha)).toBe(false)
    expect(store.voice('voice-channel', 'new-turn', sha)).toBe(false)
    expect(store.workboard(key, 43)).toBe(false)
    expect(() => store.request(key, sha, sha)).toThrow()
    expect(() => store.adminChat(key, 'original-admin-input', nextSha)).toThrow()
    expect(() => store.voice('voice-channel', 'original-turn', nextSha)).toThrow()
  })
  it('requires current original-role verification before creating any retirement record', async () => {
    await expect(publish(data, plan, async () => { throw new Error('original role unavailable') })).rejects.toThrow()
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps a published first result when its final confirmation is lost', async () => {
    await expect(publish(data, plan, async () => {
      if (await fs.lstat(path.join(directory, id + '.json')).then(() => true, () => false)) throw new Error('confirmation lost')
    })).rejects.toThrow()
    expect((await publish(data, plan)).dispatch).toBe('observe')
    expect(new WorkspaceRelocationRetirements(data).workboard(key, 42)).toBe(true)
  })
  it('never replaces an existing first document with a new selection', async () => {
    await publish(data, plan)
    const file = path.join(directory, id + '.json'), before = await fs.readFile(file)
    await expect(publish(data, { ...plan, records: [] })).rejects.toThrow()
    expect(await fs.readFile(file)).toEqual(before)
  })
  for (const invalid of ['null', 'false', '{}', '{']) it('fails closed on damaged persisted material: ' + invalid, async () => {
    await publish(data, plan)
    await fs.writeFile(path.join(directory, id + '.json'), invalid)
    expect(() => new WorkspaceRelocationRetirements(data).workboard(key, 42)).toThrow()
  })
  it('refuses an unknown artifact instead of considering the directory empty', async () => {
    await publish(data, plan); await fs.mkdir(path.join(directory, 'unknown'))
    expect(() => new WorkspaceRelocationRetirements(data).workboard(key, 42)).toThrow()
  })
  it('rejects duplicate identity with changed content before any publication', async () => {
    plan.records.push({ ...plan.records[0], source_sha256: sha })
    await expect(publish(data, plan)).rejects.toThrow()
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects body or permission fields rather than persisting private source material', async () => {
    plan.records[0].permissions = { shell: true }; plan.records[0].text = 'private input'
    await expect(publish(data, plan)).rejects.toThrow()
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses conflicting original identity across jobs before publishing the second job', async () => {
    await publish(data, plan)
    const next = { ...plan, intent_id: '22345678-1234-4123-8123-123456789abc', records: [{ ...plan.records[0], source_sha256: sha }] }
    await expect(publish(data, next)).rejects.toThrow()
    await expect(fs.lstat(path.join(directory, next.intent_id + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(new WorkspaceRelocationRetirements(data).request(key, sha, nextSha)).toBe(true)
  })
  it('rechecks the complete fixed namespace after awaiting authorization and before publication', async () => {
    let checks = 0
    await expect(publish(data, plan, async () => {
      if (++checks === 2) await fs.mkdir(path.join(directory, 'unknown-during-verification'))
    })).rejects.toThrow()
    await expect(fs.lstat(path.join(directory, id + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(directory)).toEqual(['unknown-during-verification'])
  })

  it('fails closed on an abandoned empty retirement namespace rather than treating it as no migration', async () => {
    await publish(data, plan); await fs.unlink(path.join(directory, id + '.json'))
    expect(() => new WorkspaceRelocationRetirements(data).workboard(key, 42)).toThrow()
  })

  for (const manager of [null, 42, {}]) it('reports the bounded maintenance error for an invalid Manager key ' + JSON.stringify(manager), async () => {
    plan.records[0].manager_key = manager
    await expect(publish(data, plan)).rejects.toThrow('旧恢复责任无法核实')
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

})
