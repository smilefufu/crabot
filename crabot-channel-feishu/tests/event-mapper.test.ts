/**
 * event-mapper 单元测试
 */

import { describe, it, expect } from 'vitest'
import {
  mapMessageContent,
  detectMentionCrab,
  parsePostText,
  injectMentionTags,
} from '../src/event-mapper'
import type { FeishuMention } from '../src/types'

describe('mapMessageContent — text', () => {
  it('replaces @_user_X placeholders with @Name and emits mentions', () => {
    const mentions: FeishuMention[] = [
      { key: '@_user_1', id: { open_id: 'ou_a' }, name: 'Alice' },
      { key: '@_user_2', id: { open_id: 'ou_b' }, name: 'Bob' },
    ]
    const out = mapMessageContent('text', JSON.stringify({ text: 'Hi @_user_1, @_user_2 ok' }), mentions)
    expect(out.content).toEqual({ type: 'text', text: 'Hi @Alice, @Bob ok' })
    expect(out.features.mentions).toEqual([
      { friend_id: '', platform_user_id: 'ou_a' },
      { friend_id: '', platform_user_id: 'ou_b' },
    ])
  })

  it('keeps text untouched when no mentions provided', () => {
    const out = mapMessageContent('text', JSON.stringify({ text: 'plain' }), [])
    expect(out.content).toEqual({ type: 'text', text: 'plain' })
    expect(out.features.mentions).toBeUndefined()
  })
})

describe('mapMessageContent — post', () => {
  it('flattens rich-text into plain text with newlines', () => {
    const post = JSON.stringify({
      title: 'T',
      content: [
        [{ tag: 'text', text: 'Line1' }],
        [
          { tag: 'text', text: 'Line2 ' },
          { tag: 'a', text: '链接', href: 'https://x' },
        ],
      ],
    })
    const out = mapMessageContent('post', post, [])
    expect(out.content.type).toBe('text')
    expect(out.content.text).toContain('T')
    expect(out.content.text).toContain('Line1')
    expect(out.content.text).toContain('Line2 链接')
  })
})

describe('mapMessageContent — image / file', () => {
  it('image returns image type with image_key kept in features.native_channel_id placeholder', () => {
    const out = mapMessageContent('image', JSON.stringify({ image_key: 'img_xxx' }), [])
    expect(out.content.type).toBe('image')
  })

  it('file returns file type with filename + size copied into content', () => {
    const content = JSON.stringify({ file_key: 'file_x', file_name: 'a.pdf', file_size: 1234 })
    const out = mapMessageContent('file', content, [])
    expect(out.content.type).toBe('file')
    expect(out.content.filename).toBe('a.pdf')
    expect(out.content.size).toBe(1234)
  })

  it('file accepts numeric-string file_size', () => {
    const content = JSON.stringify({ file_key: 'file_x', file_name: 'a.pdf', file_size: '5678' })
    const out = mapMessageContent('file', content, [])
    expect(out.content.size).toBe(5678)
  })

  it('file size left undefined when value is junk string', () => {
    const content = JSON.stringify({ file_key: 'file_x', file_name: 'a.pdf', file_size: 'abc' })
    const out = mapMessageContent('file', content, [])
    expect(out.content.size).toBeUndefined()
  })
})

describe('mapMessageContent — fallback types', () => {
  it('audio → text placeholder with duration', () => {
    const out = mapMessageContent('audio', JSON.stringify({ duration: 5000 }), [])
    expect(out.content.type).toBe('text')
    expect(out.content.text).toMatch(/语音/)
  })
  it('video → text placeholder', () => {
    const out = mapMessageContent('video', JSON.stringify({ duration: 7000 }), [])
    expect(out.content.text).toMatch(/视频/)
  })
  it('sticker → text placeholder', () => {
    const out = mapMessageContent('sticker', JSON.stringify({}), [])
    expect(out.content.text).toMatch(/表情/)
  })
  it('location → text placeholder with name', () => {
    const out = mapMessageContent('location', JSON.stringify({ name: 'Beijing' }), [])
    expect(out.content.text).toMatch(/位置.*Beijing/)
  })
  it('share_chat → text placeholder', () => {
    const out = mapMessageContent('share_chat', JSON.stringify({}), [])
    expect(out.content.text).toMatch(/分享/)
  })
  it('unknown msg_type falls back to [unsupported] placeholder', () => {
    const out = mapMessageContent('weird', JSON.stringify({}), [])
    expect(out.content.text).toMatch(/不支持/)
  })
  it('malformed JSON content is handled without throwing', () => {
    const out = mapMessageContent('text', '{ not valid json', [])
    expect(out.content.text).toBeDefined()
  })
})

describe('detectMentionCrab', () => {
  it('returns true when bot open_id is present in mentions', () => {
    expect(detectMentionCrab(
      [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' }],
      'ou_bot'
    )).toBe(true)
  })

  it('returns false when bot is not mentioned', () => {
    expect(detectMentionCrab(
      [{ key: '@_user_1', id: { open_id: 'ou_other' }, name: 'Other' }],
      'ou_bot'
    )).toBe(false)
  })

  it('returns false when mentions array is empty', () => {
    expect(detectMentionCrab([], 'ou_bot')).toBe(false)
  })
})

describe('parsePostText', () => {
  it('handles nested rich text with at/img tags', () => {
    const post = {
      title: 'Hi',
      content: [
        [
          { tag: 'text', text: 'a ' },
          { tag: 'at', user_id: 'ou_x', user_name: 'X' },
          { tag: 'text', text: ' b' },
        ],
      ],
    }
    const out = parsePostText(post)
    expect(out).toContain('Hi')
    expect(out).toContain('a @X b')
  })
})

describe('injectMentionTags', () => {
  it('appends <at user_id="..."></at> tags after text', () => {
    const out = injectMentionTags('Hello', [{ open_id: 'ou_a' }, { open_id: 'ou_b' }])
    expect(out).toContain('Hello')
    expect(out).toContain('<at user_id="ou_a"></at>')
    expect(out).toContain('<at user_id="ou_b"></at>')
  })

  it('returns text unchanged when no mentions', () => {
    expect(injectMentionTags('Hello', [])).toBe('Hello')
  })
})
