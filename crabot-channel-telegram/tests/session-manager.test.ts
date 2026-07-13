import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '../src/session-manager.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-session-'))
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('SessionManager', () => {
  it('derives a stable session id from channel and platform session id', () => {
    const m1 = new SessionManager('telegram-test', dataDir)
    const first = m1.upsert({
      platform_session_id: '7692507087',
      type: 'private',
      title: 'FuFu',
      sender_user_id: '7692507087',
      sender_name: 'FuFu',
    })

    fs.rmSync(path.join(dataDir, 'sessions.json'), { force: true })

    const m2 = new SessionManager('telegram-test', dataDir)
    const second = m2.upsert({
      platform_session_id: '7692507087',
      type: 'private',
      title: 'FuFu',
      sender_user_id: '7692507087',
      sender_name: 'FuFu',
    })

    expect(second.session.id).toBe(first.session.id)
    expect(second.session.id).toMatch(/^[0-9a-z]{8}$/)
  })

  it('canonicalizes loaded legacy session ids to stable ids and keeps legacy lookup aliases', () => {
    fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify([
      {
        id: 'legacy-telegram-session-id',
        channel_id: 'telegram-test',
        type: 'private',
        platform_session_id: '7692507087',
        title: 'FuFu',
        participants: [{ platform_user_id: '7692507087', role: 'member' }],
        permissions: { desktop: false, network: { mode: 'allow_all', rules: [] }, storage: [] },
        memory_scopes: ['7692507087'],
        workspace_path: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]), 'utf-8')

    const probe = new SessionManager('telegram-test', path.join(dataDir, 'stable-id-probe'))
    const stableId = probe.upsert({
      platform_session_id: '7692507087',
      type: 'private',
      title: 'FuFu',
      sender_user_id: '7692507087',
      sender_name: 'FuFu',
    }).session.id

    const manager = new SessionManager('telegram-test', dataDir)
    const session = manager.findByPlatformId('7692507087')

    expect(stableId).toMatch(/^[0-9a-z]{8}$/)
    expect(session?.id).toBe(stableId)
    expect(manager.findById(stableId)?.id).toBe(stableId)
    expect(manager.findById('legacy-telegram-session-id')?.id).toBe(stableId)
    expect(manager.listSessions('private').map((s) => s.id)).toEqual([stableId])
  })
})
