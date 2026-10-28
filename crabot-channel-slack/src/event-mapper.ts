import type { MessageFeatures, SlackEnvelope } from './types.js'

/** Code/quoted text is context, not a fresh address to the Bot. Slack encodes real mentions as <@USER>. */
export function messageFeatures(event: NonNullable<SlackEnvelope['event']>, botUserId: string): MessageFeatures {
  const directedText = (event.text || '').replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)/g, '')
    .split('\n').filter(line => !/^\s*(?:>|&gt;)/.test(line)).join('\n')
  const mentions = [...new Set([...directedText.matchAll(/<@([UW][A-Z0-9]+)>/g)].map(m => m[1]))]
  return { is_mention_crab: directedText.includes(`<@${botUserId}>`),
    ...(mentions.length ? { mentions: mentions.map(id => ({ friend_id: '', platform_user_id: id })) } : {}),
    ...(event.thread_ts ? { thread_id: event.thread_ts } : {}) }
}
export function messageText(event: NonNullable<SlackEnvelope['event']>): string {
  const files = event.files?.map(f => `[附件未读取：${f.name || f.title || '未命名文件'}]`).join('\n')
  return [event.text, files].filter(Boolean).join('\n')
}
