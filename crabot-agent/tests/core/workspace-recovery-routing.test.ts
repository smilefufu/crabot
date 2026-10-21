import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson, voiceSessionId, type SubmitVoiceTurnParams, type VoiceTurnAuthorizedPayload } from 'crabot-shared'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { AdminChatCorrelationStore } from '../../src/manager/chat-correlation-store.js'
import { ManagerWorkboardStore } from '../../src/manager/workboard-store.js'
import { VoiceInbox } from '../../src/manager/voice-inbox.js'
import { publishWorkspaceRelocationRetirements, WorkspaceRelocationRetirements } from '../../src/core/workspace-relocation-retirements.js'

const management = require('../../../scripts/lib/desktop-management.cjs')
const id = '12345678-1234-4123-8123-123456789abc', sha = '1'.repeat(64), adminKey = 'admin-web::admin-chat', key = 'channel::original'
function voicePayload(): VoiceTurnAuthorizedPayload {
  const channel = 'living-room', turn = randomUUID(), epoch = randomUUID(), session = voiceSessionId(channel)
  const request: SubmitVoiceTurnParams = { channel_id: channel, session_id: session, turn_id: turn, connection_epoch: epoch, enrollment_revision: 2,
    messages: [{ platform_message_id: turn + ':0', session: { channel_id: channel, session_id: session, type: 'group' },
      sender: { platform_user_id: 'A', platform_display_name: 'A' }, content: { type: 'text', text: 'original voice input' },
      features: { is_mention_crab: true, voice: { turn_id: turn, segment_index: 0, start_sample: 0, end_sample: 32000, anonymous_speaker: 'A', identity_status: 'matched', registration_id: 'A' } }, platform_timestamp: new Date().toISOString() }] }
  return { ...request, payload_sha256: sha256CanonicalJson(request), messages: request.messages.map(message => ({
    message: { ...message, sender: { ...message.sender, friend_id: 'A' } }, friend: { id: 'A', display_name: 'A', permission: 'normal',
      channel_identities: [{ channel_id: channel, platform_user_id: 'A' }], created_at: 't', updated_at: 't' },
  })) }
}

describe('actual Agent recovery routing with exact migration retirements', () => {
  let root: string, data: string, managers: string, actor: any, board: ManagerWorkboardStore, correlation: AdminChatCorrelationStore
  beforeEach(async () => {
    root = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-retirement-routing-')))
    data = management.ensurePrivateDataRoot(path.join(root, 'data')); managers = path.join(data, 'agent', 'managers')
    await fs.mkdir(managers, { recursive: true })
    board = new ManagerWorkboardStore(managers); correlation = new AdminChatCorrelationStore(managers)
    const registry = { routeHumanMessages: vi.fn(async (...args: any[]) => { args[5]?.onDurableQueued?.(); return { episodeId: 'new-episode' } }),
      routeWorkboardAdminUpdate: vi.fn(async () => ({ episodeId: '' })) }
    const stack = { registry, workboard: board, store: { loadCheckpoint: vi.fn(async () => null) } }
    actor = Object.assign(Object.create(UnifiedAgent.prototype), { config: { moduleId: 'finite-routing' }, runtimeClosing: false,
      workspaceRetirementStore: new WorkspaceRelocationRetirements(data), managerStack: stack, requireManagerStack: () => stack,
      adminChatCorrelationStore: () => correlation, assertRuntimeExecutionAdmission: vi.fn(), voiceDrains: new Map(),
      workboardNoticeDispatching: new Set(), workboardNoticeRetryTimers: new Map(), getAdminPort: async () => 1,
      rpcClient: { callSensitive: vi.fn(async (_port: number, method: string, params: any) => {
        expect(method).toBe('confirm_voice_turn'); return { status: 'accepted', payload_sha256: params.payload_sha256 }
      }) } })
  })
  afterEach(async () => {
    for (const timer of actor.workboardNoticeRetryTimers.values()) clearTimeout(timer)
    await vi.waitFor(() => expect(actor.workboardNoticeDispatching.size).toBe(0))
    await fs.rm(root, { recursive: true, force: true })
  })
  async function retire(records: unknown[]) {
    await publishWorkspaceRelocationRetirements({ dataDir: data, document: { schema_version: 1, intent_id: id,
      file_ready_sha256: sha, worker_closure_sha256: sha, records }, verify: async () => {} })
    actor.workspaceRetirementStore.load()
  }
  it('keeps the old pending Admin wake and original message while routing only new input', async () => {
    for (const requestId of ['old-admin-input', 'new-admin-input']) await correlation.admitInbound({ kind: 'admin_chat_wake',
      request_id: requestId, manager_key: adminKey, message_sha256: sha, received_at: new Date().toISOString(),
      message: { platform_message_id: requestId, session: { channel_id: 'admin-web', session_id: 'admin-chat', type: 'private' },
        sender: { platform_user_id: 'master', platform_display_name: 'Master' }, content: { type: 'text', text: requestId }, features: {}, platform_timestamp: new Date().toISOString() } })
    const before = await correlation.readWakes(adminKey)
    await retire([{ kind: 'admin_chat', manager_key: adminKey, request_id: 'old-admin-input', message_sha256: sha }])
    await actor.replayPendingAdminChatWakes()
    expect(actor.managerStack.registry.routeHumanMessages).toHaveBeenCalledTimes(1)
    expect(actor.managerStack.registry.routeHumanMessages.mock.calls[0][4]).toEqual({ admin_chat_request_ids: ['new-admin-input'] })
    expect(await correlation.readWakes(adminKey)).toEqual(before)
    expect((await correlation.readRequestIndex(adminKey)).get('old-admin-input')?.status).toBe('pending')
  })
  it('preserves accepted voice and actual acceptance confirmation without handing old text to a Manager', async () => {
    const inbox = new VoiceInbox(path.join(data, 'agent/voice-inbox')), original = voicePayload(), next = voicePayload()
    inbox.load(); inbox.accept(original); inbox.accept(next); actor.voiceInbox = inbox
    await retire([{ kind: 'voice', channel_id: original.channel_id, turn_id: original.turn_id, payload_sha256: original.payload_sha256 }])
    await actor.drainVoiceInbox()
    expect(actor.rpcClient.callSensitive).toHaveBeenCalledTimes(2)
    expect(actor.managerStack.registry.routeHumanMessages).toHaveBeenCalledTimes(1)
    expect(actor.managerStack.registry.routeHumanMessages.mock.calls[0][7].turnId).toBe(next.turn_id)
    const old = inbox.pending().find(record => record.turn_id === original.turn_id)!
    expect(old).toMatchObject({ phase: 'accepted', confirmed: true, payload_sha256: original.payload_sha256 })
    expect(old.payload?.messages).toEqual(original.messages)
    expect(inbox.accept(next)).toMatchObject({ phase: 'managed', confirmed: true })
  })
  it('keeps the retired board notice and business goals untouched but routes a later Admin revision', async () => {
    await board.adminCreateObjective(key, 0, { title: 'Original unfinished work', completion_criteria: ['original criterion'] })
    const original = await board.loadAdmin(key), notice = await board.pendingAdminNotice(key)
    await retire([{ kind: 'workboard', manager_key: key, revision: notice!.revision }])
    await actor.replayPendingWorkboardNotices()
    await vi.waitFor(() => expect(actor.workboardNoticeDispatching.size).toBe(0))
    expect(actor.managerStack.registry.routeWorkboardAdminUpdate).not.toHaveBeenCalled()
    expect(await board.loadAdmin(key)).toEqual(original)
    expect(await board.pendingAdminNotice(key)).toEqual(notice)
    await board.adminCreateObjective(key, original.revision, { title: 'New explicit work', completion_criteria: ['new criterion'] })
    await actor.replayPendingWorkboardNotices()
    await vi.waitFor(() => expect(actor.managerStack.registry.routeWorkboardAdminUpdate).toHaveBeenCalledTimes(1))
    expect(actor.managerStack.registry.routeWorkboardAdminUpdate.mock.calls[0][0].noticeRevision).toBe(original.revision + 1)
  })
})
