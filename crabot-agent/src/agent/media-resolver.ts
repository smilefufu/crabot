/**
 * MediaResolver - 将 ChannelMessage 中的媒体内容解析为 engine ImageBlock
 *
 * 处理本地文件路径（base64 编码）和远程 URL（下载后 base64 编码）。
 * 任何错误静默降级，不影响文本消息处理。
 */

import { promises as fs } from 'fs'
import type { ImageBlock } from '../engine/types.js'
import type { ChannelMessage } from '../types'

const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB
const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** formatMessageContent 在 text + mediaRef 都空时的兜底返回值。
 *  调用方过滤"空消息"时应 import 这个常量做 sentinel 比较，避免字符串字面量耦合。 */
export const EMPTY_MESSAGE_PLACEHOLDER = '[非文本消息]'
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export function inferMediaType(mimeType?: string, filePath?: string): ImageMediaType {
  if (mimeType && SUPPORTED_MIME_TYPES.has(mimeType)) {
    return mimeType as ImageMediaType
  }
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase()
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'png') return 'image/png'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'webp') return 'image/webp'
  }
  return 'image/png'
}

/** 读本地图片（超 MAX_IMAGE_SIZE 或不存在/不可读返回 null）。供 manager 入站图片注入复用。 */
export async function readImageFile(filePath: string): Promise<Buffer | null> {
  try {
    const buffer = await fs.readFile(filePath)
    if (buffer.length > MAX_IMAGE_SIZE) return null
    return buffer
  } catch {
    return null
  }
}

async function fetchRemoteImage(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (buffer.length > MAX_IMAGE_SIZE) return null
    return buffer
  } catch {
    return null
  }
}

/** 从一条消息收集待注入 VLM 的图片引用（media[] 权威，回退遗留单 media_url / file_path） */
function collectImageRefs(msg: ChannelMessage): Array<{ url: string; mime?: string }> {
  const items = msg.content.media
  if (items && items.length > 0) {
    return items
      .filter((m) => m.mime_type.startsWith('image/'))
      .map((m) => ({ url: m.media_url, mime: m.mime_type }))
  }
  if (msg.content.type === 'image') {
    const url = msg.content.media_url ?? msg.content.file_path
    if (url) {
      return [{ url, ...(msg.content.mime_type !== undefined ? { mime: msg.content.mime_type } : {}) }]
    }
  }
  return []
}

/**
 * 渲染媒体引用为可读文本标记。
 * media[] 存在时为权威：多条独立渲染，优先用 filename（store URL 是 agent 读不到的相对路径，
 * 渲染 filename 降低 LLM 误读）。遗留单 media_url 保持原样。
 */
function formatMediaRef(msg: ChannelMessage): string {
  const items = msg.content.media
  if (items && items.length > 0) {
    return items
      .map((m) =>
        m.mime_type.startsWith('image/')
          ? `[图片: ${m.filename ?? m.media_url}]`
          : `[文件: ${m.filename ?? m.media_url}]`
      )
      .join('\n')
  }
  if (!msg.content.media_url && !msg.content.file_path && !msg.content.handle) return ''
  switch (msg.content.type) {
    case 'image':
      return `[图片: ${msg.content.media_url ?? msg.content.filename ?? msg.content.file_path}]`
    case 'file': {
      const name = msg.content.filename ?? msg.content.media_url ?? msg.content.file_path ?? '文件'
      if (msg.content.status === 'not_fetched' && msg.content.handle) {
        const sizeHint = msg.content.size ? `, ${Math.round(msg.content.size / 1024)}KB` : ''
        return `[文件: ${name}（未下载${sizeHint}）— 需要内容时调 fetch_media 工具，handle=${msg.content.handle}]`
      }
      if (msg.content.status === 'ready' && msg.content.file_path) {
        return `[文件: ${name} | 本地路径(可用 Read 读取): ${msg.content.file_path}]`
      }
      return `[文件: ${name}]`
    }
    default:
      return ''
  }
}

/**
 * system_event 类型的消息渲染：把 affected_users 的 display_name + open_id
 * 都暴露给 LLM，否则 agent 想 @ 这些人时拿不到 ID。
 * 形如："已加入：张三 (open_id=ou_a), 李四 (open_id=ou_b)"
 */
function formatSystemEvent(msg: ChannelMessage): string {
  const text = msg.content.text ?? ''
  const affected = msg.content.affected_users ?? []
  if (affected.length === 0) return text
  const listing = affected
    .map((u) => `${u.platform_display_name} (open_id=${u.platform_user_id})`)
    .join(', ')
  // text 是 channel 给的人类可读句子（如 "已加入：张三、李四"），
  // 在它后面拼一行带 ID 的结构化清单给 LLM 用。
  return text ? `${text}\n[event_affected_users] ${listing}` : `[event_affected_users] ${listing}`
}

/**
 * 将消息内容格式化为可读文本。
 * 同时保留文本内容和媒体引用（图片、文件等），两者都有时用换行拼接。
 */
export function formatMessageContent(msg: ChannelMessage): string {
  if (msg.content.type === 'system_event') {
    return formatSystemEvent(msg)
  }
  const text = msg.content.text ?? ''
  const mediaRef = formatMediaRef(msg)

  if (text && mediaRef) return `${text}\n${mediaRef}`
  if (text) return text
  if (mediaRef) return mediaRef
  return EMPTY_MESSAGE_PLACEHOLDER
}

/**
 * 从 ChannelMessage 列表中解析图片为 engine ImageBlock。
 * media[] 存在时为权威（支持同一条消息多张图）；回退遗留单 media_url。
 */
export async function resolveImageBlocks(
  messages: ChannelMessage[]
): Promise<ImageBlock[]> {
  const refs = messages.flatMap(collectImageRefs)
  if (refs.length === 0) return []

  const results = await Promise.all(
    refs.map(async (ref): Promise<ImageBlock | null> => {
      const isRemote = ref.url.startsWith('http://') || ref.url.startsWith('https://')
      const buffer = isRemote ? await fetchRemoteImage(ref.url) : await readImageFile(ref.url)
      if (!buffer) return null
      const mediaType = inferMediaType(ref.mime, ref.url)
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
      }
    })
  )
  return results.filter((block): block is ImageBlock => block !== null)
}

/**
 * 从文件路径列表解析图片为 engine ImageBlock。
 * 供 Worker buildTaskMessage 和 Sub-agent image_paths 参数复用。
 */
export async function resolveImageFromPaths(
  paths: ReadonlyArray<string>
): Promise<ImageBlock[]> {
  const results = await Promise.all(
    paths.map(async (filePath): Promise<ImageBlock | null> => {
      const buffer = await readImageFile(filePath)
      if (!buffer) return null

      const mediaType = inferMediaType(undefined, filePath)
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      }
    })
  )
  return results.filter((block): block is ImageBlock => block !== null)
}
