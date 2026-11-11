/**
 * TelegramChannel list capability 测试
 *
 * 验证 supports_list_contacts 和 supports_list_groups 均上报 false
 * 因为 Telegram Bot API 不支持列联系人/列群
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { TelegramChannel } from '../src/telegram-channel'

let tmpDir: string
let channel: TelegramChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cap-'))
  channel = new TelegramChannel({
    module_id: 'channel-telegram-test',
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: tmpDir,
    telegram: {
      bot_token: 'token-secret',
      markdown_format: 'auto',
    },
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('TelegramChannel capabilities', () => {
  it('上报 supports_list_contacts/supports_list_groups 均为 false', () => {
    const caps = (channel as unknown as { handleGetCapabilities(): unknown }).handleGetCapabilities()
    expect(caps).toMatchObject({
      supports_list_contacts: false,
      supports_list_groups: false,
    })
  })
})
