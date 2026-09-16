import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatWechatContent } from '../src/format-wechat-content.js'
import { WechatChannel } from '../src/wechat-channel.js'

const description = '魔兽世界新版本《魔兽世界无限》官方宣测直播中一位术士玩家被一位亡灵圣骑士玩家当场秒成了渣渣#魔兽世界#魔兽世界无限#魔兽世界forever'
const raw = {
  type: 13,
  opusId: '-3435690661816956202',
  nonceId: 'sample-nonce',
  finderFeed: {
    nickname: '老罗玩魔兽',
    desc: description,
    mediaCount: 1,
    mediaList: [{ mediaType: 4, width: 1024, height: 576, videoPlayDuration: 91 }],
  },
}
const expectedText = `[视频号视频]\n作者：老罗玩魔兽\n描述：${description}\n媒体数量：1\n时长：91 秒\n尺寸：1024×576\n以上为卡片元信息；视频画面和音频尚未读取。`

describe('视频号卡片元信息', () => {
  it('保留真实样本的作者和描述，明确视频内容尚未读取，不暴露媒体链接', () => {
    expect(formatWechatContent(13, {
      ...raw,
      title: 'Your current version does not support this content.',
      url: 'https://support.weixin.qq.com/upgrade',
      video_url: 'https://example.com/encrypted-video?token=secret',
    })).toEqual({ content: { type: 'text', text: expectedText }, features: {} })
  })

  it.each([undefined, null, {}, [], 'invalid', { mediaList: [null, 'invalid', {}] }])(
    '缺少可用元信息时仍识别为视频号卡片：%j', (finderFeed) => {
      expect(formatWechatContent(13, { finderFeed }).content).toEqual({
        type: 'text', text: '[视频号卡片]\n上游未提供媒体详情。',
      })
    },
  )

  it('保留媒体原始序号，不把未知媒体类型猜成视频', () => {
    const { content } = formatWechatContent(13, { finderFeed: {
      mediaList: [null, { mediaType: 2, width: 50, height: 50 },
        { mediaType: 4, videoPlayDuration: 12 }, { mediaType: 4, width: 720, height: 1280 }],
    } })
    expect(content.text).toContain('[视频号视频]')
    expect(content.text).toContain('媒体 3 时长：12 秒')
    expect(content.text).toContain('媒体 4 尺寸：720×1280')
    expect(content.text).not.toContain('50')
    expect(content.text).not.toContain('媒体数量')
  })

  it('非法数字和类型独立忽略，不影响已有文字', () => {
    const { content } = formatWechatContent(13, { finderFeed: {
      nickname: ' 作者 ', desc: ' 第一行\n第二行 ', mediaCount: -1,
      mediaList: [{ mediaType: 4, videoPlayDuration: NaN, width: Infinity, height: 576 }],
    } })
    expect(content.text).toContain('作者：作者\n描述：第一行\n第二行')
    expect(content.text).not.toMatch(/时长：|尺寸：|媒体数量：|NaN|Infinity/)
    expect(formatWechatContent(13, { finderFeed: {
      nickname: {}, mediaCount: '1', mediaList: [{ mediaType: '4', videoPlayDuration: 91 }],
    } }).content.text).not.toContain('[视频号视频]')
  })

  it('未知媒体类型使用卡片标签', () => {
    expect(formatWechatContent(13, { finderFeed: {
      desc: '图文内容', mediaList: [{ mediaType: 2 }],
    } }).content.text).toContain('[视频号卡片]\n描述：图文内容')
  })
})

describe('视频号入站与查询', () => {
  let dataDir: string
  afterEach(() => { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }) })

  it('实时、单条和历史查询呈现相同信息，保持发送身份且不登记媒体下载', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-finder-'))
    const channel = new WechatChannel({
      module_id: 'wechat-test', module_type: 'channel', version: '0.0.1',
      protocol_version: '0.1.0', port: 0, data_dir: dataDir,
      wechat: { connector_url: 'http://localhost:0', api_key: 'test', mode: 'socketio' },
    })
    const internals = channel as any
    const session = { id: 'session-1', type: 'private', platform_session_id: 'wxid_sender' }
    internals.sessionManager = {
      upsert: vi.fn().mockReturnValue({ session, created: false }),
      findById: vi.fn().mockReturnValue(session),
    }
    const publishEvent = vi.fn().mockResolvedValue(1)
    internals.rpcClient = { publishEvent }
    const register = vi.spyOn(internals.mediaHandleStore, 'put')
    const stored = {
      id: 'message-1', fieldType: 13, fieldIsSend: 0,
      fieldCreateTime: '1789518640000', content: raw,
    }
    internals.client = {
      getMessages: vi.fn().mockResolvedValue([stored]),
      getMessageById: vi.fn().mockResolvedValue(stored),
    }
    await internals.handleWechatEvent({
      eventId: 'event-1', timestamp: 1789518640000,
      puppet: { puppetId: 'puppet-1', wxid: 'wxid_bot', nickname: 'Bot' },
      message: { id: stored.id, msgSvrId: '8068584854246004174', type: 13,
        createTime: stored.fieldCreateTime, content: raw },
      sender: { wxid: 'wxid_sender', name: 'Sender' },
      conversation: { id: 'wxid_sender', name: 'Sender', isGroup: false },
    })
    const incoming = publishEvent.mock.calls[0][0].payload.message
    const single = await internals.handleGetMessage({ session_id: session.id, platform_message_id: stored.id })
    const history = await internals.handleGetHistory({ session_id: session.id })
    for (const message of [incoming, single, history.items[0]]) {
      expect(message.content).toEqual({ type: 'text', text: expectedText })
      expect(message.sender.platform_user_id).toBe('wxid_sender')
      expect(message.platform_message_id).toBe(stored.id)
      expect(message.platform_timestamp).toBe(new Date(1789518640000).toISOString())
    }
    expect(incoming.session.session_id).toBe(session.id)
    expect(incoming.sender.platform_display_name).toBe('Sender')
    expect(register).not.toHaveBeenCalled()
  })
})
