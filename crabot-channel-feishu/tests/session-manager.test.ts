/**
 * SessionManager 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SessionManager } from '../src/session-manager'

let tmpDir: string
let mgr: SessionManager

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sm-'))
  mgr = new SessionManager('channel-feishu-test', tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('upsert (private)', () => {
  it('derives a stable session id from channel and platform session id', () => {
    const first = mgr.upsert({
      platform_session_id: 'ou_alice',
      type: 'private',
      title: 'Alice',
      sender_id: 'ou_alice',
      sender_name: 'Alice',
    })

    fs.rmSync(path.join(tmpDir, 'sessions.json'), { force: true })
    const fresh = new SessionManager('channel-feishu-test', tmpDir)
    const second = fresh.upsert({
      platform_session_id: 'ou_alice',
      type: 'private',
      title: 'Alice',
      sender_id: 'ou_alice',
      sender_name: 'Alice',
    })

    expect(second.session.id).toBe(first.session.id)
    expect(second.session.id).toMatch(/^[0-9a-z]{8}$/)
  })

  it('canonicalizes loaded legacy session ids to stable ids and keeps legacy lookup aliases', () => {
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([
      {
        id: 'legacy-feishu-session-id',
        channel_id: 'channel-feishu-test',
        type: 'private',
        platform_session_id: 'ou_alice',
        title: 'Alice',
        participants: [{ platform_user_id: 'ou_alice', role: 'member' }],
        permissions: { desktop: false, network: { mode: 'allow_all', rules: [] }, storage: [] },
        memory_scopes: ['ou_alice'],
        workspace_path: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]), 'utf-8')

    const probe = new SessionManager('channel-feishu-test', path.join(tmpDir, 'stable-id-probe'))
    const stableId = probe.upsert({
      platform_session_id: 'ou_alice',
      type: 'private',
      title: 'Alice',
      sender_id: 'ou_alice',
      sender_name: 'Alice',
    }).session.id

    const fresh = new SessionManager('channel-feishu-test', tmpDir)
    const session = fresh.findByPlatformId('ou_alice')

    expect(stableId).toMatch(/^[0-9a-z]{8}$/)
    expect(session?.id).toBe(stableId)
    expect(fresh.findById(stableId)?.id).toBe(stableId)
    expect(fresh.findById('legacy-feishu-session-id')?.id).toBe(stableId)
    expect(fresh.listSessions('private').map((s) => s.id)).toEqual([stableId])
  })

  it('first call creates a private session', () => {
    const { session, created } = mgr.upsert({
      platform_session_id: 'ou_alice',
      type: 'private',
      title: 'Alice',
      sender_id: 'ou_alice',
      sender_name: 'Alice',
    })
    expect(created).toBe(true)
    expect(session.type).toBe('private')
    expect(session.platform_session_id).toBe('ou_alice')
    expect(session.title).toBe('Alice')
    expect(session.participants).toEqual([
      { platform_user_id: 'ou_alice', role: 'member' },
    ])
  })

  it('second call returns existing session', () => {
    const a = mgr.upsert({ platform_session_id: 'ou_alice', type: 'private', title: 'Alice', sender_id: 'ou_alice', sender_name: 'Alice' })
    const b = mgr.upsert({ platform_session_id: 'ou_alice', type: 'private', title: 'Alice', sender_id: 'ou_alice', sender_name: 'Alice' })
    expect(b.created).toBe(false)
    expect(b.session.id).toBe(a.session.id)
  })
})

describe('upsert (group)', () => {
  it('adds new participant when sender not in list', () => {
    mgr.upsert({ platform_session_id: 'oc_chat1', type: 'group', title: 'Team', sender_id: 'ou_alice', sender_name: 'Alice' })
    const { session } = mgr.upsert({ platform_session_id: 'oc_chat1', type: 'group', title: 'Team', sender_id: 'ou_bob', sender_name: 'Bob' })
    const ids = session.participants.map((p) => p.platform_user_id).sort()
    expect(ids).toEqual(['ou_alice', 'ou_bob'])
  })

  it('better title overrides chat_id placeholder title', () => {
    mgr.upsert({ platform_session_id: 'oc_chat1', type: 'group', title: 'oc_chat1', sender_id: 'ou_alice', sender_name: 'Alice' })
    const { session } = mgr.upsert({ platform_session_id: 'oc_chat1', type: 'group', title: 'Team Crabot', sender_id: 'ou_alice', sender_name: 'Alice' })
    expect(session.title).toBe('Team Crabot')
  })
})

describe('upsertGroupSessionFromSnapshot', () => {
  it('creates a group session with full participants', () => {
    const r = mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat1',
      title: 'Team',
      participants: [
        { platform_user_id: 'ou_alice', role: 'member' },
        { platform_user_id: 'ou_bob', role: 'member' },
      ],
    })
    expect(r.created).toBe(true)
    expect(r.session.participants).toHaveLength(2)
  })

  it('updates an existing session with new participants list', () => {
    mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat1',
      title: 'Team',
      participants: [{ platform_user_id: 'ou_alice', role: 'member' }],
    })
    const r = mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat1',
      title: 'Team Renamed',
      participants: [
        { platform_user_id: 'ou_alice', role: 'member' },
        { platform_user_id: 'ou_bob', role: 'member' },
      ],
    })
    expect(r.created).toBe(false)
    expect(r.session.title).toBe('Team Renamed')
    expect(r.session.participants).toHaveLength(2)
  })
})

describe('applyParticipantsAdded / Removed', () => {
  it('adds new participants only (skip dup)', () => {
    mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat1',
      title: 'Team',
      participants: [{ platform_user_id: 'ou_alice', role: 'member' }],
    })
    const updated = mgr.applyParticipantsAdded('oc_chat1', [
      { platform_user_id: 'ou_alice', role: 'member' },  // dup
      { platform_user_id: 'ou_bob', role: 'member' },
    ])
    expect(updated?.participants.map((p) => p.platform_user_id).sort()).toEqual(['ou_alice', 'ou_bob'])
  })

  it('removes specified participants', () => {
    mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat1',
      title: 'Team',
      participants: [
        { platform_user_id: 'ou_alice', role: 'member' },
        { platform_user_id: 'ou_bob', role: 'member' },
      ],
    })
    const updated = mgr.applyParticipantsRemoved('oc_chat1', ['ou_alice'])
    expect(updated?.participants).toEqual([{ platform_user_id: 'ou_bob', role: 'member' }])
  })

  it('returns undefined when session not found', () => {
    expect(mgr.applyParticipantsAdded('nonexistent', [])).toBeUndefined()
    expect(mgr.applyParticipantsRemoved('nonexistent', [])).toBeUndefined()
  })
})

describe('applyChatUpdate', () => {
  it('replaces chat_id placeholder title with real chat name (repair path)', () => {
    // 模拟存量数据：handleMessageReceive 失败时把 chat_id 当 title 落了盘
    mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat1',
      title: 'oc_chat1',
      participants: [],
    })
    const updated = mgr.applyChatUpdate('oc_chat1', { title: '心术通识小伙伴' })
    expect(updated?.title).toBe('心术通识小伙伴')
  })

  it('does not overwrite real title with chat_id placeholder', () => {
    mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat1',
      title: '心术通识小伙伴',
      participants: [],
    })
    const updated = mgr.applyChatUpdate('oc_chat1', { title: 'oc_chat1' })
    expect(updated?.title).toBe('心术通识小伙伴')
  })
})

describe('removeByPlatformId', () => {
  it('removes a session and clears index', () => {
    const r = mgr.upsert({ platform_session_id: 'ou_alice', type: 'private', title: 'Alice', sender_id: 'ou_alice', sender_name: 'Alice' })
    mgr.removeByPlatformId('ou_alice')
    expect(mgr.findById(r.session.id)).toBeUndefined()
    expect(mgr.findByPlatformId('ou_alice')).toBeUndefined()
  })

  it('clears stable aliases when deleting a loaded legacy session by id', () => {
    const probe = new SessionManager('channel-feishu-test', path.join(tmpDir, 'short-id-probe'))
    const shortId = probe.upsert({
      platform_session_id: 'ou_alice',
      type: 'private',
      title: 'Alice',
      sender_id: 'ou_alice',
      sender_name: 'Alice',
    }).session.id

    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([
      {
        id: 'legacy-feishu-session-id',
        channel_id: 'channel-feishu-test',
        type: 'private',
        platform_session_id: 'ou_alice',
        title: 'Alice',
        participants: [{ platform_user_id: 'ou_alice', role: 'member' }],
        permissions: { desktop: false, network: { mode: 'allow_all', rules: [] }, storage: [] },
        memory_scopes: ['ou_alice'],
        workspace_path: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]), 'utf-8')

    const fresh = new SessionManager('channel-feishu-test', tmpDir)
    expect(fresh.findById(shortId)?.id).toBe(shortId)
    expect(fresh.findById('legacy-feishu-session-id')?.id).toBe(shortId)
    fresh.removeById('legacy-feishu-session-id')

    const recreated = fresh.upsert({
      platform_session_id: 'ou_alice',
      type: 'private',
      title: 'Alice',
      sender_id: 'ou_alice',
      sender_name: 'Alice',
    }).session

    expect(recreated.id).toBe(shortId)
    expect(fresh.findById(shortId)?.id).toBe(shortId)
  })
})

describe('persistence', () => {
  it('reloads sessions from disk', () => {
    mgr.upsert({ platform_session_id: 'ou_alice', type: 'private', title: 'Alice', sender_id: 'ou_alice', sender_name: 'Alice' })
    const mgr2 = new SessionManager('channel-feishu-test', tmpDir)
    expect(mgr2.findByPlatformId('ou_alice')).toBeDefined()
  })
})

describe('listSessions filter', () => {
  it('filters by type', () => {
    mgr.upsert({ platform_session_id: 'ou_alice', type: 'private', title: 'Alice', sender_id: 'ou_alice', sender_name: 'Alice' })
    mgr.upsert({ platform_session_id: 'oc_chat1', type: 'group', title: 'Team', sender_id: 'ou_alice', sender_name: 'Alice' })
    expect(mgr.listSessions('private')).toHaveLength(1)
    expect(mgr.listSessions('group')).toHaveLength(1)
    expect(mgr.listSessions()).toHaveLength(2)
  })
})
