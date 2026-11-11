/**
 * Telegram add_reaction：TelegramClient.setMessageReaction + TelegramChannel.handleAddReaction
 *
 * Spec: 2026-06-04-channel-task-pickup-reaction-design.md §3
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { TelegramClient } from '../src/telegram-client'
import { TelegramChannel } from '../src/telegram-channel'

describe('TelegramClient.setMessageReaction', () => {
  let fetchSpy: ReturnType<typeof vi.fn<any[], any>>
  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: true }),
    }))
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST /setMessageReaction，body 含 reaction=[{type:"emoji", emoji}]', async () => {
    const client = new TelegramClient('TKN')
    await client.setMessageReaction(12345, 678, '🫡')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.telegram.org/botTKN/setMessageReaction')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      chat_id: 12345,
      message_id: 678,
      reaction: [{ type: 'emoji', emoji: '🫡' }],
    })
  })
})

describe('TelegramChannel.handleAddReaction', () => {
  let tmpDir: string
  let channel: TelegramChannel

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-react-'))
    channel = new TelegramChannel({
      module_id: 'channel-telegram-test',
      module_type: 'channel',
      version: '0.1.0',
      protocol_version: '0.1.0',
      port: 0,
      data_dir: tmpDir,
      telegram: {
        bot_token: 'tkn',
        markdown_format: 'auto',
      },
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('capabilities.supported_features 包含 reaction', () => {
    const caps = (channel as any).handleGetCapabilities()
    expect(caps.supported_features).toContain('reaction')
  })

  it('session 不存在抛 NOT_FOUND', async () => {
    await expect(
      (channel as any).handleAddReaction({
        session_id: 'missing',
        platform_message_id: '100',
        kind: 'acknowledged',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('未知 kind 抛 INVALID_ARGUMENT', async () => {
    const sm = (channel as any).sessionManager
    const { session } = sm.upsert({
      platform_session_id: 'tg_chat_1',
      type: 'private',
      title: 't',
      sender_user_id: 'u1',
      sender_name: 'U',
    })

    await expect(
      (channel as any).handleAddReaction({
        session_id: session.id,
        platform_message_id: '100',
        kind: 'done',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('platform_message_id 不是数字抛 INVALID_ARGUMENT', async () => {
    const sm = (channel as any).sessionManager
    const { session } = sm.upsert({
      platform_session_id: 'tg_chat_1',
      type: 'private',
      title: 't',
      sender_user_id: 'u1',
      sender_name: 'U',
    })

    await expect(
      (channel as any).handleAddReaction({
        session_id: session.id,
        platform_message_id: 'not-a-number',
        kind: 'acknowledged',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('kind=acknowledged 调 client.setMessageReaction(chatId, msgId, "🫡")', async () => {
    const sm = (channel as any).sessionManager
    const { session } = sm.upsert({
      platform_session_id: 'tg_chat_99',
      type: 'private',
      title: 't',
      sender_user_id: 'u1',
      sender_name: 'U',
    })
    const spy = vi.fn(async () => undefined)
    ;(channel as any).client.setMessageReaction = spy

    const result = await (channel as any).handleAddReaction({
      session_id: session.id,
      platform_message_id: '12345',
      kind: 'acknowledged',
    })

    expect(spy).toHaveBeenCalledWith('tg_chat_99', 12345, '🫡')
    expect(result).toEqual({ added: true })
  })
})
