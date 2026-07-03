import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { TelegramChannel } from '../src/telegram-channel'

let tmpDir: string
let channel: TelegramChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-alias-'))
  channel = new TelegramChannel({
    module_id: 'telegram-test',
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: tmpDir,
    telegram: {
      bot_token: 'token-secret',
      mode: 'polling',
      webhook_url: undefined,
      webhook_secret: undefined,
      markdown_format: 'off',
    },
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('TelegramChannel session aliases', () => {
  it('uses canonical session id for message store access after resolving a legacy alias', async () => {
    const legacyId = 'legacy-telegram-session-id'
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([
      {
        id: legacyId,
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

    channel = new TelegramChannel({
      module_id: 'telegram-test',
      module_type: 'channel',
      version: '0.1.0',
      protocol_version: '0.1.0',
      port: 0,
      data_dir: tmpDir,
      telegram: {
        bot_token: 'token-secret',
        mode: 'polling',
        webhook_url: undefined,
        webhook_secret: undefined,
        markdown_format: 'off',
      },
    })

    const session = (channel as any).sessionManager.findById(legacyId)
    const stableId = session.id
    ;(channel as any).client.sendMessage = vi.fn(async () => ({ message_id: 101 }))

    await (channel as any).handleSendMessage({
      session_id: legacyId,
      content: { type: 'text', text: 'hello through alias' },
    })

    const canonicalHistory = await (channel as any).handleGetHistory({
      session_id: stableId,
      pagination: { page: 1, page_size: 20 },
    })
    const legacyHistory = await (channel as any).handleGetHistory({
      session_id: legacyId,
      pagination: { page: 1, page_size: 20 },
    })
    const legacyMessage = await (channel as any).handleGetMessage({
      session_id: legacyId,
      platform_message_id: '101',
    })

    expect(stableId).toMatch(/^[0-9a-z]{8}$/)
    expect(canonicalHistory.items).toHaveLength(1)
    expect(legacyHistory.items).toHaveLength(1)
    expect(legacyMessage.platform_message_id).toBe('101')
    expect(fs.existsSync(path.join(tmpDir, 'messages', `${stableId}.jsonl`))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'messages', `${legacyId}.jsonl`))).toBe(false)
  })

  it('migrates existing legacy message history files when resolving a legacy alias', async () => {
    const legacyId = 'legacy-telegram-session-id'
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([
      {
        id: legacyId,
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

    channel = new TelegramChannel({
      module_id: 'telegram-test',
      module_type: 'channel',
      version: '0.1.0',
      protocol_version: '0.1.0',
      port: 0,
      data_dir: tmpDir,
      telegram: {
        bot_token: 'token-secret',
        mode: 'polling',
        webhook_url: undefined,
        webhook_secret: undefined,
        markdown_format: 'off',
      },
    })

    const session = (channel as any).sessionManager.findById(legacyId)
    const stableId = session.id
    const messagesDir = path.join(tmpDir, 'messages')
    fs.mkdirSync(messagesDir, { recursive: true })
    fs.writeFileSync(
      path.join(messagesDir, `${legacyId}.jsonl`),
      JSON.stringify({
        platform_message_id: 'legacy-message-1',
        direction: 'inbound',
        sender_platform_user_id: '7692507087',
        sender_name: 'FuFu',
        content_type: 'text',
        text: 'legacy history',
        timestamp: '2026-01-01T00:00:00.000Z',
      }) + '\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(messagesDir, `${stableId}.jsonl`),
      JSON.stringify({
        platform_message_id: 'stable-message-1',
        direction: 'outbound',
        sender_platform_user_id: 'self',
        sender_name: 'Crabot',
        content_type: 'text',
        text: 'stable history',
        timestamp: '2026-01-01T00:01:00.000Z',
      }) + '\n',
      'utf-8',
    )

    const canonicalHistory = await (channel as any).handleGetHistory({
      session_id: stableId,
      pagination: { page: 1, page_size: 20 },
    })
    const legacyHistory = await (channel as any).handleGetHistory({
      session_id: legacyId,
      pagination: { page: 1, page_size: 20 },
    })
    const legacyMessage = await (channel as any).handleGetMessage({
      session_id: legacyId,
      platform_message_id: 'legacy-message-1',
    })
    const migratedCanonicalHistory = await (channel as any).handleGetHistory({
      session_id: stableId,
      pagination: { page: 1, page_size: 20 },
    })

    expect(canonicalHistory.items.map((m: any) => m.platform_message_id)).toEqual(['stable-message-1'])
    expect(legacyHistory.items.map((m: any) => m.platform_message_id)).toEqual(['stable-message-1', 'legacy-message-1'])
    expect(legacyMessage.content.text).toBe('legacy history')
    expect(migratedCanonicalHistory.items.map((m: any) => m.platform_message_id)).toEqual([
      'stable-message-1',
      'legacy-message-1',
    ])
    expect(fs.existsSync(path.join(messagesDir, `${legacyId}.jsonl`))).toBe(false)
  })
})
