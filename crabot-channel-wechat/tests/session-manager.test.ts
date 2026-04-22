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
    expect(second.session.title).toBe('工作群（新）')
    expect(second.session.participants).toHaveLength(3)
    expect(second.session.participants.map((p) => p.platform_user_id)).toEqual([
      'wxid_a',
      'wxid_b',
      'wxid_c',
    ])

    expect(manager.listSessions('group')).toHaveLength(1)
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
