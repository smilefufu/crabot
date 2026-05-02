/**
 * TelegramChannel 运行时配置端点测试 —— 验证 protocol-channel §6.1 要求的
 * get_config / update_config 形状：敏感字段 mask、markdown_format hot_reload、
 * 凭证类字段触发 requires_restart=true。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { TelegramChannel } from '../src/telegram-channel'

let tmpDir: string
let channel: TelegramChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfg-'))
  channel = new TelegramChannel({
    module_id: 'channel-telegram-test',
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
      markdown_format: 'auto',
    },
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('handleGetConfig', () => {
  it('暴露 markdown_format 顶层字段 + hot_reload schema', () => {
    const result = (channel as any).handleGetConfig()
    expect(result.config.platform).toBe('telegram')
    expect(result.config.markdown_format).toBe('auto')
    expect(result.schema['markdown_format']).toEqual({
      hot_reload: true,
      description: expect.stringContaining('Markdown'),
    })
  })

  it('bot_token 被 mask 成 ***', () => {
    const result = (channel as any).handleGetConfig()
    expect(result.config.credentials.bot_token).toBe('***')
  })

  it('未配置 webhook_secret 时不在 credentials 里出现', () => {
    const result = (channel as any).handleGetConfig()
    expect(result.config.credentials.webhook_secret).toBeUndefined()
  })
})

describe('handleUpdateConfig', () => {
  it('改 markdown_format 不需要重启', () => {
    const result = (channel as any).handleUpdateConfig({ config: { markdown_format: 'on' } })
    expect(result.requires_restart).toBe(false)
    expect(result.config.markdown_format).toBe('on')
  })

  it('忽略非法 markdown_format 值，保留旧值', () => {
    ;(channel as any).handleUpdateConfig({ config: { markdown_format: 'on' } })
    const result = (channel as any).handleUpdateConfig({ config: { markdown_format: 'bogus' } })
    expect(result.config.markdown_format).toBe('on')
  })

  it('改 mode 触发 requires_restart=true', () => {
    const result = (channel as any).handleUpdateConfig({ config: { mode: 'webhook' } })
    expect(result.requires_restart).toBe(true)
  })

  it('credentials.bot_token 写入新值时触发 requires_restart=true', () => {
    const result = (channel as any).handleUpdateConfig({ config: { credentials: { bot_token: 'new-token' } } })
    expect(result.requires_restart).toBe(true)
  })

  it('credentials.bot_token 收到 *** 占位符时不会被覆盖', () => {
    const result = (channel as any).handleUpdateConfig({ config: { credentials: { bot_token: '***' } } })
    expect(result.requires_restart).toBe(false)
    expect((channel as any).telegramConfig.bot_token).toBe('token-secret')
  })

  it('credentials.bot_token 收到空字符串时跳过，不清掉真值', () => {
    const result = (channel as any).handleUpdateConfig({ config: { credentials: { bot_token: '' } } })
    expect(result.requires_restart).toBe(false)
    expect((channel as any).telegramConfig.bot_token).toBe('token-secret')
  })
})
