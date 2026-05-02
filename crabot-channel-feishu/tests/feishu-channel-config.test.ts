/**
 * FeishuChannel 运行时配置端点测试 —— 仅校验 handleGetConfig / handleUpdateConfig
 * 中 markdown_format 字段的暴露 + 热更新行为，protocol-channel §6.1 要求 channel 模块
 * 必须实现这两个 RPC，且 markdown_format 是 hot_reload。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Domain: { Feishu: 'feishu', Lark: 'lark' },
    Client: class MockLarkClient {
      im = {}
      contact = { v3: { user: {} } }
      request = vi.fn()
    },
    WSClient: class MockWSClient {
      start() { return Promise.resolve() }
      close() { return Promise.resolve() }
    },
    EventDispatcher: class MockEventDispatcher {
      register() { return this }
    },
  }
})

import { FeishuChannel } from '../src/feishu-channel'

let tmpDir: string
let channel: FeishuChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-cfg-'))
  channel = new FeishuChannel({
    module_id: 'channel-feishu-test',
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: tmpDir,
    feishu: {
      app_id: 'cli_x',
      app_secret: 'sec',
      domain: 'feishu',
      only_respond_to_mentions: true,
      markdown_format: 'auto',
    },
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('buildMarkdownCard (schema 2.0)', () => {
  it('启用时返回 schema 2.0 卡片，原文不预处理', () => {
    const text = '# 标题\n\n| col | val |\n|---|---|\n| a | 1 |'
    const card = (channel as any).buildMarkdownCard(text)
    expect(card).not.toBeNull()
    expect(card.schema).toBe('2.0')
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: text }])
  })

  it('format=off 时返回 null（走纯文本）', () => {
    ;(channel as any).feishuConfig.markdown_format = 'off'
    expect((channel as any).buildMarkdownCard('**bold**')).toBeNull()
  })

  it('format=auto 且无 markdown 标记时返回 null', () => {
    ;(channel as any).feishuConfig.markdown_format = 'auto'
    expect((channel as any).buildMarkdownCard('普通文字没有标记')).toBeNull()
  })
})

describe('handleGetConfig', () => {
  it('暴露 markdown_format 顶层字段且 schema 标注 hot_reload', () => {
    const result = (channel as any).handleGetConfig()
    expect(result.config.markdown_format).toBe('auto')
    expect(result.schema['markdown_format']).toEqual({
      hot_reload: true,
      description: expect.stringContaining('Markdown'),
    })
  })

  it('app_secret 被 mask 为 ***', () => {
    const result = (channel as any).handleGetConfig()
    expect(result.config.credentials.app_secret).toBe('***')
  })
})

describe('handleUpdateConfig', () => {
  it('改 markdown_format 不需要重启 (hot_reload=true)', () => {
    const result = (channel as any).handleUpdateConfig({ config: { markdown_format: 'on' } })
    expect(result.requires_restart).toBe(false)
    expect(result.config.markdown_format).toBe('on')
  })

  it('忽略非法 markdown_format 值，保留旧值', () => {
    ;(channel as any).handleUpdateConfig({ config: { markdown_format: 'on' } })
    const result = (channel as any).handleUpdateConfig({ config: { markdown_format: 'whatever' } })
    expect(result.config.markdown_format).toBe('on')
  })

  it('credentials.app_id 嵌套路径写入触发 requires_restart=true', () => {
    const result = (channel as any).handleUpdateConfig({
      config: { credentials: { app_id: 'cli_new' } },
    })
    expect(result.requires_restart).toBe(true)
    expect((channel as any).feishuConfig.app_id).toBe('cli_new')
  })

  it('credentials.app_secret 写入新值时触发 restart 并更新真值', () => {
    const result = (channel as any).handleUpdateConfig({
      config: { credentials: { app_secret: 'sec-new' } },
    })
    expect(result.requires_restart).toBe(true)
    expect((channel as any).feishuConfig.app_secret).toBe('sec-new')
  })

  it('credentials.app_secret 收到 *** 占位符时不会被覆盖', () => {
    const result = (channel as any).handleUpdateConfig({
      config: { credentials: { app_secret: '***' } },
    })
    expect(result.requires_restart).toBe(false)
    expect((channel as any).feishuConfig.app_secret).toBe('sec')
  })

  it('group.only_respond_to_mentions 嵌套路径热更新生效', () => {
    expect((channel as any).feishuConfig.only_respond_to_mentions).toBe(true)
    const result = (channel as any).handleUpdateConfig({
      config: { group: { only_respond_to_mentions: false } },
    })
    expect(result.requires_restart).toBe(false)
    expect((channel as any).feishuConfig.only_respond_to_mentions).toBe(false)
  })

  it('admin 端原样回传整个嵌套结构时所有字段都按预期生效', () => {
    const snapshot = (channel as any).handleGetConfig().config
    // 模拟 admin web：把 get_config 的输出原样修改后 PATCH 回来
    const edited = {
      ...snapshot,
      credentials: { ...snapshot.credentials, app_id: 'cli_x2' },
      group: { only_respond_to_mentions: false },
      markdown_format: 'on',
    }
    const result = (channel as any).handleUpdateConfig({ config: edited })
    expect(result.requires_restart).toBe(true) // app_id 改了
    expect((channel as any).feishuConfig.app_id).toBe('cli_x2')
    expect((channel as any).feishuConfig.only_respond_to_mentions).toBe(false)
    expect((channel as any).feishuConfig.markdown_format).toBe('on')
    // app_secret 是 mask *** 不应清空
    expect((channel as any).feishuConfig.app_secret).toBe('sec')
  })
})
