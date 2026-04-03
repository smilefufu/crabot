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
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

function inferMediaType(mimeType?: string, filePath?: string): ImageMediaType {
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

async function readLocalFile(filePath: string): Promise<Buffer | null> {
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

/**
 * 将消息内容格式化为可读文本。
 * 优先返回文本内容，非文本消息（图片、文件等）返回占位描述。
 */
export function formatMessageContent(msg: ChannelMessage): string {
  const text = msg.content.text
  if (text) return text

  switch (msg.content.type) {
    case 'image':
      return `[图片${msg.content.media_url ? ': ' + msg.content.media_url : ''}]`
    case 'file':
      return `[文件: ${msg.content.filename ?? msg.content.media_url ?? '未知'}]`
    default:
      return '[非文本消息]'
  }
}

/**
 * 从 ChannelMessage 列表中解析图片为 engine ImageBlock
 */
export async function resolveImageBlocks(
  messages: ChannelMessage[]
): Promise<ImageBlock[]> {
  // Fast path: skip all I/O if no image messages present
  const imageMessages = messages.filter(
    (msg) => msg.content.type === 'image' && msg.content.media_url
  )
  if (imageMessages.length === 0) return []

  // Resolve all images in parallel
  const results = await Promise.all(
    imageMessages.map(async (msg): Promise<ImageBlock | null> => {
      const url = msg.content.media_url!
      const isRemote = url.startsWith('http://') || url.startsWith('https://')
      const buffer = isRemote
        ? await fetchRemoteImage(url)
        : await readLocalFile(url)

      if (!buffer) return null

      const mediaType = inferMediaType(msg.content.mime_type, url)
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
