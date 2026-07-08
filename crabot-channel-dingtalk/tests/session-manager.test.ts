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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-sm-'))
  mgr = new SessionManager('channel-dingtalk-test', tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('upsert (private)', () => {
  it('first call creates a private session', () => {
    const { session, created } = mgr.upsert({
      platform_session_id: 'staff_alice',
      type: 'private',
      title: 'Alice',
      sender_id: 'staff_alice',
      sender_name: 'Alice',
    })
    expect(created).toBe(true)
    expect(session.type).toBe('private')
    expect(session.platform_session_id).toBe('staff_alice')
    expect(session.title).toBe('Alice')
    expect(session.participants).toEqual([
      { platform_user_id: 'staff_alice', role: 'member' },
    ])
  })

  it('second call returns existing session', () => {
    const a = mgr.upsert({ platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice' })
    const b = mgr.upsert({ platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice' })
    expect(b.created).toBe(false)
    expect(b.session.id).toBe(a.session.id)
  })

  it('derives a stable session id from channel and platform session id', () => {
    const first = mgr.upsert({ platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice' })
    // 删掉本地缓存后重建：同 channel_id + platform_session_id 必须得到同一个 id
    fs.rmSync(path.join(tmpDir, 'sessions.json'), { force: true })
    const fresh = new SessionManager('channel-dingtalk-test', tmpDir)
    const second = fresh.upsert({ platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice' })
    expect(second.session.id).toBe(first.session.id)
    expect(second.session.id).toMatch(/^[0-9a-z]{8}$/)
  })

  it('canonicalizes loaded legacy session ids to stable ids and keeps legacy lookup aliases', () => {
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([
      {
        id: 'legacy-dingtalk-session-id',
        channel_id: 'channel-dingtalk-test',
        type: 'private',
        platform_session_id: 'staff_alice',
        title: 'Alice',
        participants: [{ platform_user_id: 'staff_alice', role: 'member' }],
        permissions: { desktop: false, network: { mode: 'allow_all', rules: [] }, storage: [] },
        memory_scopes: ['staff_alice'],
        workspace_path: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]), 'utf-8')

    // 用一个独立目录 probe 出该 channel_id + platform 的 stable id
    const probe = new SessionManager('channel-dingtalk-test', path.join(tmpDir, 'stable-id-probe'))
    const stableId = probe.upsert({
      platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice',
    }).session.id

    const fresh = new SessionManager('channel-dingtalk-test', tmpDir)
    const session = fresh.findByPlatformId('staff_alice')

    expect(stableId).toMatch(/^[0-9a-z]{8}$/)
    expect(session?.id).toBe(stableId)
    expect(fresh.findById(stableId)?.id).toBe(stableId)
    // legacy 随机 id 仍可查到（alias），但返回 canonical stable id
    expect(fresh.findById('legacy-dingtalk-session-id')?.id).toBe(stableId)
    expect(fresh.listSessions('private').map((s) => s.id)).toEqual([stableId])
  })
})

describe('upsert (group)', () => {
  it('adds new participant when sender not in list', () => {
    mgr.upsert({ platform_session_id: 'cid_chat1', type: 'group', title: 'Team', sender_id: 'staff_alice', sender_name: 'Alice' })
    const { session } = mgr.upsert({ platform_session_id: 'cid_chat1', type: 'group', title: 'Team', sender_id: 'staff_bob', sender_name: 'Bob' })
    const ids = session.participants.map((p) => p.platform_user_id).sort()
    expect(ids).toEqual(['staff_alice', 'staff_bob'])
  })

  it('better title overrides conversationId placeholder title', () => {
    mgr.upsert({ platform_session_id: 'cid_chat1', type: 'group', title: 'cid_chat1', sender_id: 'staff_alice', sender_name: 'Alice' })
    const { session } = mgr.upsert({ platform_session_id: 'cid_chat1', type: 'group', title: 'Team Crabot', sender_id: 'staff_alice', sender_name: 'Alice' })
    expect(session.title).toBe('Team Crabot')
  })

  it('does not add an empty participant when sender_id is unresolved (create path)', () => {
    // 群里首条消息来自无法解析身份的成员（senderStaffId/senderId 都空）→ 不能写入空 platform_user_id
    const { session, created } = mgr.upsert({
      platform_session_id: 'cid_chat1', type: 'group', title: 'Team', sender_id: '', sender_name: '',
    })
    expect(created).toBe(true)
    expect(session.participants).toEqual([])
  })

  it('skips empty sender_id but still admits later identifiable members', () => {
    mgr.upsert({ platform_session_id: 'cid_chat1', type: 'group', title: 'Team', sender_id: '', sender_name: '' })
    const { session } = mgr.upsert({ platform_session_id: 'cid_chat1', type: 'group', title: 'Team', sender_id: 'uid_bob', sender_name: 'Bob' })
    expect(session.participants).toEqual([{ platform_user_id: 'uid_bob', role: 'member' }])
  })
})

describe('upsertGroupSessionFromSnapshot', () => {
  it('creates a group session with full participants', () => {
    const r = mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'cid_chat1',
      title: 'Team',
      participants: [
        { platform_user_id: 'staff_alice', role: 'member' },
        { platform_user_id: 'staff_bob', role: 'member' },
      ],
    })
    expect(r.created).toBe(true)
    expect(r.session.participants).toHaveLength(2)
  })

  it('updates an existing session with new participants list', () => {
    mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'cid_chat1',
      title: 'Team',
      participants: [{ platform_user_id: 'staff_alice', role: 'member' }],
    })
    const r = mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'cid_chat1',
      title: 'Team Renamed',
      participants: [
        { platform_user_id: 'staff_alice', role: 'member' },
        { platform_user_id: 'staff_bob', role: 'member' },
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
      platform_session_id: 'cid_chat1',
      title: 'Team',
      participants: [{ platform_user_id: 'staff_alice', role: 'member' }],
    })
    const updated = mgr.applyParticipantsAdded('cid_chat1', [
      { platform_user_id: 'staff_alice', role: 'member' },  // dup
      { platform_user_id: 'staff_bob', role: 'member' },
    ])
    expect(updated?.participants.map((p) => p.platform_user_id).sort()).toEqual(['staff_alice', 'staff_bob'])
  })

  it('removes specified participants', () => {
    mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'cid_chat1',
      title: 'Team',
      participants: [
        { platform_user_id: 'staff_alice', role: 'member' },
        { platform_user_id: 'staff_bob', role: 'member' },
      ],
    })
    const updated = mgr.applyParticipantsRemoved('cid_chat1', ['staff_alice'])
    expect(updated?.participants).toEqual([{ platform_user_id: 'staff_bob', role: 'member' }])
  })

  it('returns undefined when session not found', () => {
    expect(mgr.applyParticipantsAdded('nonexistent', [])).toBeUndefined()
    expect(mgr.applyParticipantsRemoved('nonexistent', [])).toBeUndefined()
  })
})

describe('applyChatUpdate', () => {
  it('replaces conversationId placeholder title with real chat name (repair path)', () => {
    mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'cid_chat1',
      title: 'cid_chat1',
      participants: [],
    })
    const updated = mgr.applyChatUpdate('cid_chat1', { title: '心术通识小伙伴' })
    expect(updated?.title).toBe('心术通识小伙伴')
  })

  it('does not overwrite real title with conversationId placeholder', () => {
    mgr.upsertGroupSessionFromSnapshot({
      platform_session_id: 'cid_chat1',
      title: '心术通识小伙伴',
      participants: [],
    })
    const updated = mgr.applyChatUpdate('cid_chat1', { title: 'cid_chat1' })
    expect(updated?.title).toBe('心术通识小伙伴')
  })
})

describe('removeByPlatformId', () => {
  it('removes a session and clears index', () => {
    const r = mgr.upsert({ platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice' })
    mgr.removeByPlatformId('staff_alice')
    expect(mgr.findById(r.session.id)).toBeUndefined()
    expect(mgr.findByPlatformId('staff_alice')).toBeUndefined()
  })

  it('clears stable aliases when deleting a loaded legacy session by id', () => {
    const probe = new SessionManager('channel-dingtalk-test', path.join(tmpDir, 'short-id-probe'))
    const shortId = probe.upsert({
      platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice',
    }).session.id

    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([
      {
        id: 'legacy-dingtalk-session-id',
        channel_id: 'channel-dingtalk-test',
        type: 'private',
        platform_session_id: 'staff_alice',
        title: 'Alice',
        participants: [{ platform_user_id: 'staff_alice', role: 'member' }],
        permissions: { desktop: false, network: { mode: 'allow_all', rules: [] }, storage: [] },
        memory_scopes: ['staff_alice'],
        workspace_path: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]), 'utf-8')

    const fresh = new SessionManager('channel-dingtalk-test', tmpDir)
    expect(fresh.findById(shortId)?.id).toBe(shortId)
    expect(fresh.findById('legacy-dingtalk-session-id')?.id).toBe(shortId)
    fresh.removeById('legacy-dingtalk-session-id')

    // 删除后 legacy alias 已清；重建同 platform 仍得到同一 stable id
    const recreated = fresh.upsert({
      platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice',
    }).session
    expect(recreated.id).toBe(shortId)
    expect(fresh.findById(shortId)?.id).toBe(shortId)
  })
})

describe('persistence', () => {
  it('reloads sessions from disk', () => {
    mgr.upsert({ platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice' })
    const mgr2 = new SessionManager('channel-dingtalk-test', tmpDir)
    expect(mgr2.findByPlatformId('staff_alice')).toBeDefined()
  })
})

describe('listSessions filter', () => {
  it('filters by type', () => {
    mgr.upsert({ platform_session_id: 'staff_alice', type: 'private', title: 'Alice', sender_id: 'staff_alice', sender_name: 'Alice' })
    mgr.upsert({ platform_session_id: 'cid_chat1', type: 'group', title: 'Team', sender_id: 'staff_alice', sender_name: 'Alice' })
    expect(mgr.listSessions('private')).toHaveLength(1)
    expect(mgr.listSessions('group')).toHaveLength(1)
    expect(mgr.listSessions()).toHaveLength(2)
  })
})
