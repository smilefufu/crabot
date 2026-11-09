/**
 * FeishuChannel add_reaction RPC + capability 测试。
 *
 * Spec: 2026-06-04-channel-task-pickup-reaction-design.md §2
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  Client: class MockLarkClient {
    request = vi.fn(async () => ({ code: 0 }))
    im = {
      message: { create: vi.fn(), reply: vi.fn(), get: vi.fn(), list: vi.fn() },
      messageResource: { get: vi.fn() },
      chat: { list: vi.fn(async () => ({ data: { items: [], has_more: false } })) },
      chatMembers: { get: vi.fn() },
      image: { create: vi.fn() },
      file: { create: vi.fn() },
    }
    contact = { v3: { user: { get: vi.fn(), list: vi.fn() } } }
  },
  WSClient: class MockWSClient {
    start() { return Promise.resolve() }
    close() { return Promise.resolve() }
  },
  EventDispatcher: class MockEventDispatcher {
    register() { return this }
  },
}))

import { FeishuChannel } from '../src/feishu-channel'

let tmpDir: string
let channel: FeishuChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-react-'))
  channel = new FeishuChannel({
    module_id: 'channel-feishu-test',
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    data_dir: tmpDir,
    feishu: {
      app_id: 'cli_x',
      app_secret: 'sec',
      domain: 'feishu',
      only_respond_to_mentions: true,
      markdown_format: 'auto',
    },
  }, { publishEvent: async () => {} })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('handleGetCapabilities', () => {
  it('supported_features 包含 reaction', () => {
    const caps = (channel as any).handleGetCapabilities()
    expect(caps.supported_features).toContain('reaction')
  })
})

describe('handleAddReaction', () => {
  it('未知 kind 抛 INVALID_ARGUMENT', async () => {
    // upsert 一个 session 让 NOT_FOUND 不触发
    ;(channel as any).sessionManager.upsert({
      platform_session_id: 'oc_x',
      type: 'group',
      title: 'G',
      sender_id: '',
      sender_name: '',
    })
    const session = (channel as any).sessionManager.findByPlatformId('oc_x')

    await expect(
      (channel as any).handleAddReaction({
        session_id: session.id,
        platform_message_id: 'om_1',
        kind: 'done',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('session 不存在抛 NOT_FOUND', async () => {
    await expect(
      (channel as any).handleAddReaction({
        session_id: 'missing',
        platform_message_id: 'om_1',
        kind: 'acknowledged',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('kind=acknowledged 调 client.addReaction(messageId, "OnIt") 返回 added:true', async () => {
    ;(channel as any).sessionManager.upsert({
      platform_session_id: 'oc_x',
      type: 'group',
      title: 'G',
      sender_id: '',
      sender_name: '',
    })
    const session = (channel as any).sessionManager.findByPlatformId('oc_x')
    const addReaction = vi.fn(async () => undefined)
    ;(channel as any).client.addReaction = addReaction

    const result = await (channel as any).handleAddReaction({
      session_id: session.id,
      platform_message_id: 'om_1',
      kind: 'acknowledged',
    })

    expect(addReaction).toHaveBeenCalledWith('om_1', 'OnIt')
    expect(result).toEqual({ added: true })
  })
})
