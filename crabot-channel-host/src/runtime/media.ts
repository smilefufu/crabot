/**
 * runtime/media.ts - 媒体处理功能实现
 *
 * 实现 OpenClaw 插件需要的媒体处理功能：
 * - fetchRemoteMedia: 下载远程媒体文件
 * - saveMediaBuffer: 保存媒体到本地
 * - detectMime: 基于 magic bytes 检测 MIME 类型
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// ============================================================================
// MIME 类型检测（基于 magic bytes）
// ============================================================================

/**
 * 常见文件类型的 magic bytes 签名
 */
const MIME_SIGNATURES: Array<{
  mime: string
  ext: string
  check: (buffer: Buffer) => boolean
}> = [
  // 图片
  {
    mime: 'image/png',
    ext: 'png',
    check: (buf) => buf.length >= 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG',
  },
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    check: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    mime: 'image/gif',
    ext: 'gif',
    check: (buf) =>
      buf.length >= 6 &&
      (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a'),
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    check: (buf) =>
      buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP',
  },
  // 文档
  {
    mime: 'application/pdf',
    ext: 'pdf',
    check: (buf) => buf.length >= 4 && buf.toString('ascii', 0, 4) === '%PDF',
  },
  // 视频
  {
    mime: 'video/mp4',
    ext: 'mp4',
    check: (buf) => {
      // MP4: ftyp at offset 4
      if (buf.length >= 12) {
        const ftyp = buf.toString('ascii', 4, 8)
        return ftyp === 'ftyp' || ftyp === 'mp42' || ftyp === 'isom' || ftyp === 'M4V '
      }
      return false
    },
  },
  {
    mime: 'video/quicktime',
    ext: 'mov',
    check: (buf) => {
      if (buf.length >= 12) {
        const atom = buf.toString('ascii', 4, 8)
        return atom === 'moov' || atom === 'mdat' || atom === 'wide'
      }
      return false
    },
  },
  // 音频
  {
    mime: 'audio/mpeg',
    ext: 'mp3',
    check: (buf) => {
      // ID3 tag or MPEG frame sync
      if (buf.length >= 3) {
        return (
          buf.toString('ascii', 0, 3) === 'ID3' ||
          (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
        )
      }
      return false
    },
  },
  {
    mime: 'audio/wav',
    ext: 'wav',
    check: (buf) =>
      buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WAVE',
  },
  {
    mime: 'audio/ogg',
    ext: 'ogg',
    check: (buf) => buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS',
  },
  // 压缩文件
  {
    mime: 'application/zip',
    ext: 'zip',
    check: (buf) => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04,
  },
]

/**
 * 基于 magic bytes 检测 MIME 类型
 */
export function detectMime(buffer: Buffer): string {
  if (!buffer || buffer.length === 0) {
    return 'application/octet-stream'
  }

  for (const sig of MIME_SIGNATURES) {
    if (sig.check(buffer)) {
      return sig.mime
    }
  }

  return 'application/octet-stream'
}

/**
 * 根据 MIME 类型获取文件扩展名
 */
function getExtensionFromMime(mime: string): string {
  const sig = MIME_SIGNATURES.find((s) => s.mime === mime)
  if (sig) return sig.ext

  // 常见 MIME 类型的 fallback
  const mimeToExt: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'application/pdf': 'pdf',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
    'application/zip': 'zip',
    'application/x-tar': 'tar',
    'application/x-gzip': 'gz',
  }

  return mimeToExt[mime] || 'bin'
}

// ============================================================================
// 媒体下载
// ============================================================================

export interface FetchRemoteMediaParams {
  url: string
  maxBytes?: number
}

export interface FetchRemoteMediaResult {
  buffer: Buffer
  contentType?: string
}

/**
 * 下载远程媒体文件
 */
export async function fetchRemoteMedia(
  params: FetchRemoteMediaParams
): Promise<FetchRemoteMediaResult> {
  const { url, maxBytes = 50 * 1024 * 1024 } = params // 默认最大 50MB

  console.log(`[Media] Fetching remote media: ${url}`)

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status} ${response.statusText}`)
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`Media size ${contentLength} exceeds maxBytes ${maxBytes}`)
  }

  const contentType = response.headers.get('content-type') ?? undefined

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  if (buffer.length > maxBytes) {
    throw new Error(`Media size ${buffer.length} exceeds maxBytes ${maxBytes}`)
  }

  console.log(`[Media] Fetched ${buffer.length} bytes, content-type: ${contentType}`)

  return { buffer, contentType }
}

// ============================================================================
// 媒体保存
// ============================================================================

export interface SaveMediaBufferParams {
  buffer: Buffer
  contentType: string
  direction: 'inbound' | 'outbound'
  maxBytes?: number
  fileName?: string
}

export interface SaveMediaBufferResult {
  path: string
  contentType: string
}

/**
 * 保存媒体到本地
 */
export async function saveMediaBuffer(
  params: SaveMediaBufferParams,
  dataDir: string
): Promise<SaveMediaBufferResult> {
  const { buffer, contentType, direction, maxBytes = 50 * 1024 * 1024, fileName } = params

  if (buffer.length > maxBytes) {
    throw new Error(`Media size ${buffer.length} exceeds maxBytes ${maxBytes}`)
  }

  // 确定存储目录
  const mediaDir = path.join(dataDir, 'media', direction)
  await fs.mkdir(mediaDir, { recursive: true })

  // 确定文件名和扩展名
  const ext = getExtensionFromMime(contentType)
  const finalFileName = fileName
    ? `${path.basename(fileName, path.extname(fileName))}.${ext}`
    : `${randomUUID()}.${ext}`

  const filePath = path.join(mediaDir, finalFileName)

  // 写入文件
  await fs.writeFile(filePath, buffer)

  console.log(`[Media] Saved ${buffer.length} bytes to ${filePath}`)

  return {
    path: filePath,
    contentType,
  }
}

// ============================================================================
// 创建 media runtime 对象
// ============================================================================

export function createMediaRuntime(dataDir: string) {
  return {
    resolveMedia: () => null,

    fetchRemoteMedia: async (params: FetchRemoteMediaParams): Promise<FetchRemoteMediaResult> => {
      return fetchRemoteMedia(params)
    },

    saveMediaBuffer: async (
      params: SaveMediaBufferParams
    ): Promise<SaveMediaBufferResult> => {
      return saveMediaBuffer(params, dataDir)
    },
  }
}

export function createMediaRuntimeTopLevel() {
  return {
    loadWebMedia: async () => null,

    detectMime: async (buffer: Buffer): Promise<string> => {
      return detectMime(buffer)
    },

    mediaKindFromMime: (mime: string): string | null => {
      if (mime.startsWith('image/')) return 'image'
      if (mime.startsWith('video/')) return 'video'
      if (mime.startsWith('audio/')) return 'audio'
      return null
    },

    isVoiceCompatibleAudio: (mime: string): boolean => {
      const voiceMimes = [
        'audio/mpeg',
        'audio/mp3',
        'audio/wav',
        'audio/ogg',
        'audio/aac',
        'audio/mp4',
        'audio/x-m4a',
      ]
      return voiceMimes.includes(mime)
    },

    getImageMetadata: async () => null,

    resizeToJpeg: async () => null,
  }
}