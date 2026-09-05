import type { ChannelMessage } from '../types.js'
import type { ManagerKey } from './types.js'

export type ManagerInboundMessageStatus = 'queued' | 'processing'

/** 运行时所有者提供的内部事实；只在同步快照期间存活。 */
export interface ManagerInboundMessageFact {
  message: ChannelMessage
  status: ManagerInboundMessageStatus
  episode_id?: string
}

export interface ManagerInboundMessageSnapshot {
  platform_message_id: string
  status: ManagerInboundMessageStatus
  preview: string
  sender_display_name?: string
  platform_timestamp: string
  episode_id?: string
}

export interface GetManagerInboundStatusAdminParams {
  manager_key: ManagerKey
}

export interface GetManagerInboundStatusAdminResult {
  manager_key: ManagerKey
  snapshot_at: string
  items: ManagerInboundMessageSnapshot[]
}

const PREVIEW_MAX_CHARS = 180

function messagePreview(message: ChannelMessage): string {
  const marker = message.content.type === 'image'
    ? '[图片]'
    : message.content.type === 'file'
      ? '[文件]'
      : message.content.type === 'system_event'
        ? '[系统事件]'
        : ''
  return [marker, message.content.text]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim() || '[空消息]'
}

function truncatePreview(text: string): string {
  const chars = Array.from(text)
  return chars.length > PREVIEW_MAX_CHARS
    ? `${chars.slice(0, PREVIEW_MAX_CHARS).join('')}…`
    : text
}

/** 按协议完成脱敏、去重和稳定排序，不修改任何运行时容器或消息对象。 */
export function projectManagerInboundMessages(
  facts: ReadonlyArray<ManagerInboundMessageFact>,
  redact: (text: string) => string,
): ManagerInboundMessageSnapshot[] {
  const selected = new Map<string, ManagerInboundMessageFact>()
  for (const fact of facts) {
    const id = fact.message.platform_message_id
    const current = selected.get(id)
    if (
      current === undefined
      || (fact.status === 'processing' && current.status === 'queued')
      || (fact.status === current.status
        && fact.message.platform_timestamp < current.message.platform_timestamp)
    ) {
      selected.set(id, fact)
    }
  }

  return Array.from(selected.values())
    .map(({ message, status, episode_id }) => {
      const senderDisplayName = message.sender.platform_display_name.trim()
      return {
        platform_message_id: message.platform_message_id,
        status,
        preview: truncatePreview(redact(messagePreview(message))),
        ...(senderDisplayName ? { sender_display_name: senderDisplayName } : {}),
        platform_timestamp: message.platform_timestamp,
        ...(status === 'processing' && episode_id ? { episode_id } : {}),
      }
    })
    .sort((a, b) => (
      a.platform_timestamp.localeCompare(b.platform_timestamp)
      || a.platform_message_id.localeCompare(b.platform_message_id)
    ))
}
