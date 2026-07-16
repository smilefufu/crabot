import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

let dataDir: string
let generatedDir: string
let channel: FeishuChannel

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-send-media-'))
  generatedDir = fs.mkdtempSync(path.join(process.cwd(), 'generated-images-test-'))
  channel = new FeishuChannel({
    module_id: 'channel-feishu-test',
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: dataDir,
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
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(generatedDir, { recursive: true, force: true })
})

describe('FeishuChannel local media sending', () => {
  it('uploads an image from a generated-images path outside the former channel allowlist', async () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02])
    const imagePath = path.join(generatedDir, 'generated.png')
    fs.writeFileSync(imagePath, image)

    const session = (channel as any).sessionManager.upsert({
      platform_session_id: 'oc_generated',
      type: 'group',
      title: 'Generated images',
      sender_id: 'ou_user',
      sender_name: 'User',
    }).session
    const uploadImage = vi.fn(async () => 'img_generated')
    const sendImage = vi.fn(async () => ({ message_id: 'om_generated', create_time: '1710000000000' }))
    ;(channel as any).client.uploadImage = uploadImage
    ;(channel as any).client.sendImage = sendImage

    const result = await (channel as any).handleSendMessage({
      session_id: session.id,
      content: { type: 'image', file_path: imagePath, filename: 'generated.png' },
    })

    expect(uploadImage).toHaveBeenCalledWith(image)
    expect(sendImage).toHaveBeenCalledWith(
      { type: 'chat_id', id: 'oc_generated' },
      'img_generated',
    )
    expect(result.platform_message_id).toBe('om_generated')
  })
})
