import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import type { SessionParticipant } from '../src/types.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-session-'))
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('SessionManager.upsertGroupSessionFromSnapshot', () => {
  it('derives a stable session id from channel and platform session id', () => {
    const m1 = new SessionManager('vongcloud-wechat', dataDir)
    const first = m1.upsertGroupSessionFromSnapshot({
      platform_session_id: '12345@chatroom',
      title: '工作群',
      participants: [{ platform_user_id: 'wxid_a', role: 'member' }],
    })

    fs.rmSync(path.join(dataDir, 'sessions.json'), { force: true })

    const m2 = new SessionManager('vongcloud-wechat', dataDir)
    const second = m2.upsertGroupSessionFromSnapshot({
      platform_session_id: '12345@chatroom',
      title: '工作群',
      participants: [{ platform_user_id: 'wxid_a', role: 'member' }],
    })

    expect(second.session.id).toBe(first.session.id)
    expect(second.session.id).toMatch(/^[0-9a-z]{8}$/)
  })

  it('canonicalizes loaded legacy session ids to stable ids and keeps legacy lookup aliases', () => {
    fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify([
      {
        id: 'legacy-session-id',
        channel_id: 'vongcloud-wechat',
        type: 'group',
        platform_session_id: '12345@chatroom',
        title: '工作群',
        participants: [{ platform_user_id: 'wxid_a', role: 'member' }],
        permissions: { desktop: false, network: { mode: 'allow_all', rules: [] }, storage: [] },
        memory_scopes: ['12345@chatroom'],
        workspace_path: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]), 'utf-8')

    const probe = new SessionManager('vongcloud-wechat', path.join(dataDir, 'stable-id-probe'))
    const stableId = probe.upsertGroupSessionFromSnapshot({
      platform_session_id: '12345@chatroom',
      title: '工作群',
      participants: [{ platform_user_id: 'wxid_a', role: 'member' }],
    }).session.id

    const manager = new SessionManager('vongcloud-wechat', dataDir)
    const session = manager.findByPlatformId('12345@chatroom')

    expect(stableId).toMatch(/^[0-9a-z]{8}$/)
    expect(session?.id).toBe(stableId)
    expect(manager.findById(stableId)?.id).toBe(stableId)
    expect(manager.findById('legacy-session-id')?.id).toBe(stableId)
    expect(manager.listSessions('group').map((s) => s.id)).toEqual([stableId])
  })

  it('persists canonical stable ids after updating a loaded legacy session', () => {
    fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify([
      {
        id: 'legacy-session-id',
        channel_id: 'vongcloud-wechat',
        type: 'group',
        platform_session_id: '12345@chatroom',
        title: '12345@chatroom',
        participants: [{ platform_user_id: 'wxid_a', role: 'member' }],
        permissions: { desktop: false, network: { mode: 'allow_all', rules: [] }, storage: [] },
        memory_scopes: ['12345@chatroom'],
        workspace_path: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]), 'utf-8')

    const manager = new SessionManager('vongcloud-wechat', dataDir)
    const stableId = manager.findById('legacy-session-id')!.id
    manager.upsert({
      platform_session_id: '12345@chatroom',
      type: 'group',
      title: '工作群',
      sender_wxid: 'wxid_b',
      sender_name: 'Bob',
    })

    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf-8')) as Array<{ id: string }>
    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe(stableId)
    expect(saved[0].id).not.toBe('legacy-session-id')
  })

  it('creates a new group session with full participant snapshot', () => {
    const manager = new SessionManager('vongcloud-wechat', dataDir)

    const participants: SessionParticipant[] = [
      { platform_user_id: 'wxid_a', role: 'member' },
      { platform_user_id: 'wxid_b', role: 'member' },
    ]

    const { session, created } = manager.upsertGroupSessionFromSnapshot({
      platform_session_id: '12345@chatroom',
      title: '工作群',
      participants,
    })

    expect(created).toBe(true)
    expect(session.type).toBe('group')
    expect(session.channel_id).toBe('vongcloud-wechat')
    expect(session.platform_session_id).toBe('12345@chatroom')
    expect(session.title).toBe('工作群')
    expect(session.participants).toEqual(participants)
    expect(session.memory_scopes).toEqual(['12345@chatroom'])
    expect(session.workspace_path).toBe('')
  })

  it('updates existing group session idempotently (title + participants replaced)', () => {
    const manager = new SessionManager('vongcloud-wechat', dataDir)

    const first = manager.upsertGroupSessionFromSnapshot({
      platform_session_id: '12345@chatroom',
      title: '工作群',
      participants: [{ platform_user_id: 'wxid_a', role: 'member' }],
    })

    const second = manager.upsertGroupSessionFromSnapshot({
      platform_session_id: '12345@chatroom',
      title: '工作群（新）',
      participants: [
        { platform_user_id: 'wxid_a', role: 'member' },
        { platform_user_id: 'wxid_b', role: 'member' },
        { platform_user_id: 'wxid_c', role: 'member' },
      ],
    })

    expect(second.created).toBe(false)
    expect(second.session.id).toBe(first.session.id)
    expect(second.session.created_at).toBe(first.session.created_at)
    expect(second.session.title).toBe('工作群（新）')
    expect(second.session.participants).toHaveLength(3)
    expect(second.session.participants.map((p) => p.platform_user_id)).toEqual([
      'wxid_a',
      'wxid_b',
      'wxid_c',
    ])

    expect(manager.listSessions('group')).toHaveLength(1)
  })

  it('upgrades title via upsert when incoming event carries a friendly name', () => {
    const manager = new SessionManager('vongcloud-wechat', dataDir)

    const { session: created } = manager.upsert({
      platform_session_id: '12345@chatroom',
      type: 'group',
      title: '12345@chatroom',
      sender_wxid: 'wxid_a',
      sender_name: 'Alice',
    })
    expect(created.title).toBe('12345@chatroom')

    const { session: upgraded } = manager.upsert({
      platform_session_id: '12345@chatroom',
      type: 'group',
      title: '工作群',
      sender_wxid: 'wxid_b',
      sender_name: 'Bob',
    })
    expect(upgraded.id).toBe(created.id)
    expect(upgraded.title).toBe('工作群')

    const { session: preserved } = manager.upsert({
      platform_session_id: '12345@chatroom',
      type: 'group',
      title: '12345@chatroom',
      sender_wxid: 'wxid_c',
      sender_name: 'Carol',
    })
    expect(preserved.title).toBe('工作群')
  })

  it('persists group sessions across SessionManager restarts', () => {
    const m1 = new SessionManager('vongcloud-wechat', dataDir)
    m1.upsertGroupSessionFromSnapshot({
      platform_session_id: '12345@chatroom',
      title: '工作群',
      participants: [{ platform_user_id: 'wxid_a', role: 'member' }],
    })

    const m2 = new SessionManager('vongcloud-wechat', dataDir)
    const sessions = m2.listSessions('group')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].platform_session_id).toBe('12345@chatroom')
    expect(sessions[0].channel_id).toBe('vongcloud-wechat')
  })
})
