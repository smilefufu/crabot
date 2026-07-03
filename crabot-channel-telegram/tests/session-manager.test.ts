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

  it('keeps loaded session ids canonical and accepts new short stable ids as aliases', () => {
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
      {
        id: '21c6ef56-a63b-e1dd-d3f6-a337320ac3aa',
        channel_id: 'telegram-test',
        type: 'private',
        platform_session_id: '123456789',
        title: 'Other',
        participants: [{ platform_user_id: '123456789', role: 'member' }],
        permissions: { desktop: false, network: { mode: 'allow_all', rules: [] }, storage: [] },
        memory_scopes: ['123456789'],
        workspace_path: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]), 'utf-8')

    const manager = new SessionManager('telegram-test', dataDir)
    const session = manager.findByPlatformId('7692507087')
    const uuidSession = manager.findByPlatformId('123456789')
    const probe = new SessionManager('telegram-test', path.join(dataDir, 'short-id-probe'))
    const shortId = probe.upsert({
      platform_session_id: '7692507087',
      type: 'private',
      title: 'FuFu',
      sender_user_id: '7692507087',
      sender_name: 'FuFu',
    }).session
    const uuidShortId = probe.upsert({
      platform_session_id: '123456789',
      type: 'private',
      title: 'Other',
      sender_user_id: '123456789',
      sender_name: 'Other',
    }).session

    expect(session?.id).toBe('legacy-telegram-session-id')
    expect(uuidSession?.id).toBe('21c6ef56-a63b-e1dd-d3f6-a337320ac3aa')
    expect(shortId.id).toMatch(/^[0-9a-z]{8}$/)
    expect(uuidShortId.id).toMatch(/^[0-9a-z]{8}$/)
    expect(manager.findById(shortId.id)?.id).toBe('legacy-telegram-session-id')
    expect(manager.findById(uuidShortId.id)?.id).toBe('21c6ef56-a63b-e1dd-d3f6-a337320ac3aa')
  })
})
