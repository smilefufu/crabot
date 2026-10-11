import { describe, it, expect } from 'vitest'
import { formatWechatContent } from '../src/format-wechat-content.js'

describe('formatWechatContent quote (type=18) with quoted_resource_url', () => {
  it('quotes an image: lifts content.type to image and exposes media_url', () => {
    const { content, features } = formatWechatContent(18, {
      text: '看下这张',
      quoted_sender_name: '张三',
      quoted_content: '[图片]',
      quoted_svr_id: 'svr-123',
      quoted_message_id: 'msg_original',
      quoted_msg_type: 1,
      quoted_resource_url: 'https://cdn.example.com/abc.jpg',
    })

    expect(content.type).toBe('image')
    expect(content.media_url).toBe('https://cdn.example.com/abc.jpg')
    expect(content.text).toContain('> 张三: [图片]')
    expect(content.text).toContain('看下这张')
    expect(features.quote_message_id).toBe('msg_original')
  })

  it('quotes an emoji (type=47): lifts to image', () => {
    const { content } = formatWechatContent(18, {
      text: '哈哈',
      quoted_sender_name: '李四',
      quoted_content: '[表情]',
      quoted_msg_type: 47,
      quoted_resource_url: 'https://cdn.example.com/emoji.gif',
    })

    expect(content.type).toBe('image')
    expect(content.media_url).toBe('https://cdn.example.com/emoji.gif')
  })

  it('quotes a video (type=43): lifts to file with video mime', () => {
    const { content } = formatWechatContent(18, {
      text: '这段',
      quoted_sender_name: '王五',
      quoted_content: '[视频]',
      quoted_msg_type: 43,
      quoted_resource_url: 'https://cdn.example.com/v.mp4',
    })

    expect(content.type).toBe('file')
    expect(content.media_url).toBe('https://cdn.example.com/v.mp4')
    expect(content.mime_type).toBe('video/mp4')
  })

  it('quotes a text (no quoted_resource_url): stays as text', () => {
    const { content, features } = formatWechatContent(18, {
      text: '同意',
      quoted_sender_name: '张三',
      quoted_content: '我之前说的那个事',
      quoted_svr_id: 'svr-9',
      quoted_message_id: 'msg_text',
      quoted_msg_type: 0,
    })

    expect(content.type).toBe('text')
    expect(content.text).toContain('> 张三: 我之前说的那个事')
    expect(content.text).toContain('同意')
    expect(features.quote_message_id).toBe('msg_text')
  })

  it('quote without quoted_msg_type: falls back to text even if URL exists', () => {
    const { content } = formatWechatContent(18, {
      text: 'reply',
      quoted_content: '[图片]',
      quoted_resource_url: 'https://cdn.example.com/x.jpg',
    })

    expect(content.type).toBe('text')
  })

  it('quote when quotedContent missing: still emits placeholder line', () => {
    const { content } = formatWechatContent(18, {
      text: '回复',
      quoted_sender_name: '张三',
    })

    expect(content.type).toBe('text')
    expect(content.text).toContain('> 张三: [消息]')
  })
})

describe('formatWechatContent file (type=9 / 1090519089)', () => {
  // 文档参考：wechat-connector/docs/BOT_INTEGRATION.md
  // "入站文件消息（type=9）的字段保证与降级"

  it('ack 成功路径：file_url + file_name + file_size 完整', () => {
    const { content } = formatWechatContent(9, {
      type: 9,
      text: '陈敏的家庭保障分析报告.pdf',
      describe: '5440092',
      file_url: 'http://p.wcssq.cn/idwxid_xxxxxxxxx',
      file_name: '陈敏的家庭保障分析报告.pdf',
      file_size: 5440092,
    })

    expect(content.type).toBe('file')
    expect(content.media_url).toBe('http://p.wcssq.cn/idwxid_xxxxxxxxx')
    expect(content.filename).toBe('陈敏的家庭保障分析报告.pdf')
    expect(content.size).toBe(5440092)
  })

  it('envelope 兜底：仅 text + describe（ack 字段缺失时取 puppet 原始上报）', () => {
    const { content } = formatWechatContent(9, {
      type: 9,
      text: '报告.pdf',
      describe: '102400',
    })

    expect(content.type).toBe('file')
    expect(content.filename).toBe('报告.pdf')
    expect(content.size).toBe(102400)
    expect(content.media_url).toBeUndefined()
  })

  it('60s 超时降级：有 file_name + file_size 但缺 file_url', () => {
    const { content } = formatWechatContent(9, {
      type: 9,
      text: '报告.pdf',
      describe: '5440092',
      file_name: '报告.pdf',
      file_size: 5440092,
    })

    expect(content.type).toBe('file')
    expect(content.filename).toBe('报告.pdf')
    expect(content.size).toBe(5440092)
    expect(content.media_url).toBeUndefined()
  })

  it('兼容 type=1090519089 (FILE)：与 type=9 走同一路径', () => {
    const { content } = formatWechatContent(1090519089, {
      type: 1090519089,
      file_url: 'https://cdn.example.com/a.zip',
      file_name: 'a.zip',
      file_size: 1024,
    })

    expect(content.type).toBe('file')
    expect(content.media_url).toBe('https://cdn.example.com/a.zip')
    expect(content.filename).toBe('a.zip')
    expect(content.size).toBe(1024)
  })

  it('完全缺字段：filename 回退到「未知文件」，不抛错', () => {
    const { content } = formatWechatContent(9, { type: 9 })

    expect(content.type).toBe('file')
    expect(content.filename).toBe('未知文件')
    expect(content.media_url).toBeUndefined()
    expect(content.size).toBeUndefined()
  })
})


it('图片引用按需读取，不凭引用快照宣称高清或自动注入图像', () => {
  for (const url of [undefined, 'https://cdn/old-thumb']) {
    expect(formatWechatContent(18, { text: '识图', quoted_svr_id: '514607585156521130',
      quoted_msg_type: 1, quoted_resource_url: url }).content).toMatchObject({ type: 'image', image_quality: 'unknown' })
  }
})

it('原消息未解析时不把微信服务端 ID 当成可查询引用 ID', () => {
  const result = formatWechatContent(18, { text: '看引用图', quoted_svr_id: '514607585156521130' })
  expect(result.features).not.toHaveProperty('quote_message_id')
  expect(result.content.text).toContain('看引用图')
})
