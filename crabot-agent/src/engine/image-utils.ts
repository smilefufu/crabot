import type { EngineMessage, EngineToolResultMessage } from './types'

// --- Configuration ---

/** Maximum number of recent images to keep as base64 in message history */
const MAX_RECENT_IMAGES = 2

/** Max width for screenshot compression (height scales proportionally) */
const COMPRESS_MAX_WIDTH = 1024

/** JPEG quality for compressed screenshots (0-100) */
const COMPRESS_QUALITY = 70

// --- Sharp lazy loading (optional native dependency) ---

type SharpFn = (input: Buffer) => {
  resize: (opts: { width: number; withoutEnlargement: boolean }) => {
    jpeg: (opts: { quality: number }) => {
      toBuffer: () => Promise<Buffer>
    }
  }
}

let sharpFn: SharpFn | null | undefined

async function getSharp(): Promise<SharpFn | null> {
  if (sharpFn !== undefined) return sharpFn
  try {
    const mod = await import('sharp')
    sharpFn = mod.default as unknown as SharpFn
    return sharpFn
  } catch {
    sharpFn = null
    return null
  }
}

// --- Image Compression ---

interface ImageData {
  readonly media_type: string
  readonly data: string
}

/**
 * Compress a base64 image: resize to max width + re-encode as JPEG.
 * Returns a new ImageData with reduced size, or the original if sharp is unavailable.
 */
export async function compressImage(image: ImageData): Promise<ImageData> {
  try {
    const sharp = await getSharp()
    if (!sharp) return image

    const inputBuffer = Buffer.from(image.data, 'base64')
    const outputBuffer = await sharp(inputBuffer)
      .resize({ width: COMPRESS_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: COMPRESS_QUALITY })
      .toBuffer()

    return {
      media_type: 'image/jpeg',
      data: outputBuffer.toString('base64'),
    }
  } catch {
    return image
  }
}

/**
 * Compress all images in a tool result batch before storing in messages.
 * Called on new tool results before they're added to the message history.
 */
export async function compressToolResultImages(
  results: ReadonlyArray<{
    tool_use_id: string
    content: string
    images?: ReadonlyArray<ImageData>
    is_error: boolean
  }>
): Promise<Array<{
  tool_use_id: string
  content: string
  images?: ReadonlyArray<ImageData>
  is_error: boolean
}>> {
  return Promise.all(results.map(async (r) => {
    if (!r.images?.length) return r

    const compressed = await Promise.all(r.images.map(compressImage))
    return { ...r, images: compressed }
  }))
}

// --- Image Aging (prune old images from message history) ---

function isToolResultMessage(msg: EngineMessage): msg is EngineToolResultMessage {
  return msg.role === 'user' && 'toolResults' in msg
}

/**
 * Prune old images from message history, keeping only the most recent N.
 * Walks messages from end to start. Images beyond the limit are replaced
 * with a text placeholder. Mutates the messages array in place.
 */
export function pruneOldImages(messages: EngineMessage[]): void {
  let imageCount = 0

  // Walk from newest to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!isToolResultMessage(msg)) continue

    let needsUpdate = false
    const updatedResults = msg.toolResults.map((tr) => {
      if (!tr.images?.length) return tr

      if (imageCount < MAX_RECENT_IMAGES) {
        // Keep these images
        imageCount += tr.images.length
        return tr
      }

      // Over limit — replace images with placeholder
      needsUpdate = true
      imageCount += tr.images.length
      return {
        ...tr,
        images: undefined,
        content: tr.content
          ? `${tr.content}\n[截图已省略 - 仅保留最近${MAX_RECENT_IMAGES}张]`
          : `[截图已省略 - 仅保留最近${MAX_RECENT_IMAGES}张]`,
      }
    })

    if (needsUpdate) {
      // Replace the message in-place with updated toolResults
      messages[i] = {
        ...msg,
        toolResults: updatedResults,
      } as EngineToolResultMessage
    }
  }
}
