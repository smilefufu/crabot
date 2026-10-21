import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { sha256CanonicalJson } from 'crabot-shared'
import { ManagerWorkboardStore } from '../../src/manager/workboard-store.js'
import { AdminChatCorrelationStore } from '../../src/manager/chat-correlation-store.js'
import { encodeSegment } from '../../src/workers/harness/ledger-store.js'
import { captureWorkspaceRelocationRecovery } from '../../src/core/workspace-relocation-recovery-capture.js'
const management = require('../../../scripts/lib/desktop-management.cjs')
const key = 'channel::original', requestId = '1'.repeat(64), sha = '2'.repeat(64), turn = '12345678-1234-4123-8123-123456789abc'
function checkpoint() {
  return JSON.stringify({ episodeId: 'original-episode', state: { key, recent: [{ role: 'user', content: 'ORIGINAL_PRIVATE_INPUT' }], foldedCount: 0 },
    envelopes: [], wakeIndex: -1, pending: [], hasEngineMessages: true, turns: [], responses: [], tools: [], pendingToolCallIds: ['unknown-operation'],
    adminChatClaims: [], transientMessageIds: [], spawnedWorkerIds: [], execution: { successfulSendMessageTargets: [], continuedWorkers: [],
      needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0 } }) + '\n'
}

describe('fixed read-only Agent recovery responsibility capture', () => {
  let root: string, data: string, agent: string, manager: string, active: string
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-recovery-capture-')))
    data = management.ensurePrivateDataRoot(path.join(root, 'data')); agent = path.join(data, 'agent')
    fs.mkdirSync(agent)
    manager = path.join(agent, 'managers', encodeSegment(key)); active = path.join(manager, 'running.json')
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
  function write(file: string, body: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 })
  }
  it('accepts genuinely absent business namespaces without creating directories or reading workspace files', async () => {
    const before = fs.readdirSync(agent)
    const snapshot = await captureWorkspaceRelocationRecovery(data)
    expect(snapshot.records).toEqual([]); expect(snapshot.checkpoints).toEqual([])
    expect(fs.readdirSync(agent)).toEqual(before)
    expect(fs.existsSync(path.join(data, 'workspace-control'))).toBe(false)
  })
  it('captures exact pending identities and raw checkpoint digests, never body, permission or tool results', async () => {
    write(active, checkpoint())
    write(path.join(manager, 'requests.json'), { version: 1, requests: [{ schema_version: 1, request_id: requestId, manager_key: key,
      source_id: 'original-source', source_sha256: sha, selection: { start: 0, end: 1 }, created_at: new Date().toISOString(), permission_sources: { private: 'PRIVATE_PERMISSIONS' },
      delivery: { kind: 'origin', requester_friend_id: null }, worker_ids: [], status: 'open' }] })
    const requestCheckpoint = path.join(agent, 'conversation-requests', requestId, 'session', encodeSegment(key), 'running.json')
    write(requestCheckpoint, checkpoint())
    write(path.join(agent, 'conversation-requests', requestId, 'owner.json'), { schema_version: 1, manager_key: key, request_id: requestId, source_sha256: sha })
    const correlation = new AdminChatCorrelationStore(path.join(agent, 'managers'))
    await correlation.admitInbound({ kind: 'admin_chat_wake', manager_key: key, request_id: 'original-admin-input', message_sha256: sha,
      received_at: new Date().toISOString(), message: { platform_message_id: 'original-admin-input', session: { channel_id: 'channel', session_id: 'original', type: 'group' },
        sender: { platform_user_id: 'owner', platform_display_name: 'Owner' }, content: { type: 'text', text: 'PRIVATE_ADMIN_BODY' }, features: {}, platform_timestamp: new Date().toISOString() } })
    const board = new ManagerWorkboardStore(path.join(agent, 'managers'))
    await board.adminCreateObjective(key, 0, { title: 'PRIVATE_GOAL', completion_criteria: ['unfinished goal'] })
    write(path.join(agent, 'voice-inbox', sha256CanonicalJson(['room', turn]) + '.json'), { protocol_version: 2, channel_id: 'room', turn_id: turn,
      payload_sha256: sha, accepted_at: new Date().toISOString(), phase: 'managed', confirmed: false })
    const before = fs.readFileSync(active), originalBoard = await board.loadAdmin(key)
    const snapshot = await captureWorkspaceRelocationRecovery(data)
    expect(snapshot.records).toEqual(expect.arrayContaining([
      { kind: 'request', manager_key: key, request_id: requestId, source_sha256: sha },
      { kind: 'admin_chat', manager_key: key, request_id: 'original-admin-input', message_sha256: sha },
      { kind: 'workboard', manager_key: key, revision: 1 },
      { kind: 'voice', channel_id: 'room', turn_id: turn, payload_sha256: sha },
    ]))
    expect(snapshot.checkpoints).toHaveLength(2)
    expect(snapshot.checkpoints.map((item: any) => item.source.kind).sort()).toEqual(['manager', 'request'])
    expect(snapshot.files).toHaveLength(7)
    expect(JSON.stringify(snapshot)).not.toMatch(/ORIGINAL_PRIVATE_INPUT|PRIVATE_PERMISSIONS|PRIVATE_ADMIN_BODY|PRIVATE_GOAL|unknown-operation/)
    expect(fs.readFileSync(active)).toEqual(before); expect(fs.readFileSync(requestCheckpoint)).toEqual(before)
    expect(await board.loadAdmin(key)).toEqual(originalBoard)
    expect(Object.isFrozen(snapshot.records)).toBe(true)
    expect(fs.existsSync(path.join(manager, 'workspace-relocation-history'))).toBe(false)
  })
  it('rejects the total budget before reading any selected body', async () => {
    write(active, checkpoint()); fs.truncateSync(active, 65 * 1024 * 1024)
    const read = vi.spyOn(fs, 'readSync')
    await expect(captureWorkspaceRelocationRecovery(data)).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_RECOVERY_CAPTURE', stage: 'budget' })
    expect(read).not.toHaveBeenCalled(); expect(fs.statSync(active).size).toBe(65 * 1024 * 1024)
  })
  it('refuses hard-linked source files and leaves both names intact', async () => {
    write(active, checkpoint()); const kept = path.join(root, 'kept'); fs.linkSync(active, kept)
    await expect(captureWorkspaceRelocationRecovery(data)).rejects.toThrow()
    expect(fs.readFileSync(active)).toEqual(fs.readFileSync(kept))
  })
  it('detects a same-size source change during its actual read and never repairs or archives it', async () => {
    write(active, checkpoint()); const read = fs.readSync, original = fs.statSync(active, { bigint: true }); let changed = false
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: any[]) => {
      const count = (read as any)(...args)
      const opened = fs.fstatSync(args[0], { bigint: true })
      if (count && !changed && opened.dev === original.dev && opened.ino === original.ino) {
        changed = true; fs.writeFileSync(active, checkpoint().replace('ORIGINAL_PRIVATE_INPUT', 'MODIFIED_PRIVATE_INPUT'))
      }
      return count
    }) as typeof fs.readSync)
    const unrelated = path.join(root, 'unrelated-reader')
    fs.writeFileSync(unrelated, 'unrelated read')
    fs.readFileSync(unrelated)
    expect(changed).toBe(false)
    await expect(captureWorkspaceRelocationRecovery(data)).rejects.toThrow()
    expect(changed).toBe(true); expect(fs.readFileSync(active, 'utf8')).toContain('MODIFIED_PRIVATE_INPUT')
    expect(fs.existsSync(path.join(manager, 'workspace-relocation-history'))).toBe(false)
  })
  it('refuses corrupt checkpoints without returning private parser contents', async () => {
    write(active, '{ORIGINAL_PRIVATE_INPUT')
    let error: any
    try { await captureWorkspaceRelocationRecovery(data) } catch (cause) { error = cause }
    expect(error?.code).toBe('CRABOT_WORKSPACE_RECOVERY_CAPTURE')
    expect(String(error?.message)).not.toContain('ORIGINAL_PRIVATE_INPUT')
    expect(fs.readFileSync(active, 'utf8')).toBe('{ORIGINAL_PRIVATE_INPUT')
  })
  it('refuses a missing Agent or already cancelled capture without creating replacement state', async () => {
    fs.rmdirSync(agent)
    await expect(captureWorkspaceRelocationRecovery(data)).rejects.toThrow()
    expect(fs.existsSync(agent)).toBe(false)
    const controller = new AbortController(); controller.abort()
    await expect(captureWorkspaceRelocationRecovery(data, { signal: controller.signal })).rejects.toThrow()
    expect(fs.existsSync(agent)).toBe(false)
  })
  for (const variant of ['missing', 'manager', 'source']) it('preserves a request checkpoint whose original owner cannot be verified: ' + variant, async () => {
    write(path.join(manager, 'requests.json'), { version: 1, requests: [{ schema_version: 1, request_id: requestId, manager_key: key, source_sha256: sha, status: 'open' }] })
    const directory = path.join(agent, 'conversation-requests', requestId)
    const checkpointFile = path.join(directory, 'session', encodeSegment(key), 'running.json')
    write(checkpointFile, checkpoint())
    if (variant !== 'missing') write(path.join(directory, 'owner.json'), { schema_version: 1, manager_key: variant === 'manager' ? 'other::conversation' : key,
      request_id: requestId, source_sha256: variant === 'source' ? '3'.repeat(64) : sha })
    await expect(captureWorkspaceRelocationRecovery(data)).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_RECOVERY_CAPTURE', stage: 'request-owner' })
    expect(fs.readFileSync(checkpointFile, 'utf8')).toBe(checkpoint())
    expect(fs.existsSync(path.join(path.dirname(checkpointFile), 'workspace-relocation-history'))).toBe(false)
  })
  it('interprets a supported v3 board without persisting its lazy v4 migration or changing the pending revision', async () => {
    const file = path.join(manager, 'workboard.json'), before = JSON.stringify({ schema_version: 3, manager_key: key, revision: 7, objectives: [], archive: [],
      pending_admin_notice: { revision: 7, created_at: new Date().toISOString(), attempts: 0 } })
    write(file, before)
    const snapshot = await captureWorkspaceRelocationRecovery(data)
    expect(snapshot.records).toEqual([{ kind: 'workboard', manager_key: key, revision: 7 }])
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('does not enter closed request histories or read their unrelated old checkpoint files', async () => {
    write(path.join(manager, 'requests.json'), { version: 1, requests: [{ schema_version: 1, request_id: requestId, manager_key: key, source_sha256: sha, status: 'closed' }] })
    const history = path.join(agent, 'conversation-requests', requestId)
    write(path.join(history, 'owner.json'), 'unrelated closed history')
    write(path.join(history, 'session', encodeSegment(key), 'running.json'), 'unrelated closed checkpoint')
    const open = vi.spyOn(fs, 'openSync'), snapshot = await captureWorkspaceRelocationRecovery(data)
    expect(snapshot.records).toEqual([]); expect(snapshot.checkpoints).toEqual([])
    expect(snapshot.files).toHaveLength(1)
    expect(open.mock.calls.some(args => String(args[0]).startsWith(history))).toBe(false)
    expect(fs.readFileSync(path.join(history, 'owner.json'), 'utf8')).toBe('unrelated closed history')
  })

})
