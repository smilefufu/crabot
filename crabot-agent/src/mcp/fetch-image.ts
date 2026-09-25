import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { FetchImageParams, FetchImageResult } from 'crabot-shared'
import type { ToolCallContext } from '../engine/types.js'
import type { CrabMessagingDeps, MessagingToolResult } from './crab-messaging.js'

const WAIT_MS = 120_000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
type ImageResult = FetchImageResult | { status: 'cancelled' | 'timed_out' | 'interrupted'; note: string }

/** 等待只属于原工具调用；不发布会话唤醒，不持久化恢复。 */
export function createImageReader(deps: CrabMessagingDeps) {
  const calls = new WeakMap<AbortSignal, Map<string, Promise<ImageResult>>>()
  return async (args: Record<string, unknown>, context: ToolCallContext = {}): Promise<MessagingToolResult> => {
    const text = (value: unknown): MessagingToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
    try {
      const result = await wait(args, context)
      if (result.status !== 'ready' || args.include_image === false) return text(result)
      if (!imageTypes.has(result.mime_type) || result.size > MAX_IMAGE_BYTES) throw new Error('图片格式或大小不支持')
      const bytes = await readFile(result.file_path, { signal: context.abortSignal })
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过 20MB 上限')
      return { ...text(result), images: [{ media_type: result.mime_type, data: bytes.toString('base64') }] }
    } catch (error) {
      return text(context.abortSignal?.aborted ? { status: 'cancelled', note: '取图已取消，无后台唤醒。' }
        : { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  function wait(args: Record<string, unknown>, context: ToolCallContext): Promise<ImageResult> {
    const signal = context.abortSignal
    if (!signal) return read(args, context)
    let pending = calls.get(signal)
    if (!pending) { pending = new Map(); calls.set(signal, pending) }
    const key = JSON.stringify([args.channel_id, args.session_id, args.platform_message_id, args.quality ?? 'hd'])
    const existing = pending.get(key)
    if (existing) return existing
    const work = read(args, context).finally(() => pending!.delete(key))
    pending.set(key, work)
    return work
  }

  async function read(args: Record<string, unknown>, context: ToolCallContext): Promise<ImageResult> {
    const controller = new AbortController()
    let stopped: 'cancelled' | 'timed_out' | 'interrupted' | undefined
    const stop = (reason: typeof stopped) => { if (!stopped) { stopped = reason; controller.abort() } }
    const onAbort = () => stop('cancelled')
    context.abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (context.abortSignal?.aborted) onAbort()
    const timeout = setTimeout(() => stop('timed_out'), WAIT_MS)
    const interruption = context.hasPendingExternalInput
      ? setInterval(() => { if (context.hasPendingExternalInput?.()) stop('interrupted') }, 100)
      : undefined
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('图片等待已结束')), { once: true })
    })
    // Promise.race always observes both branches; an RPC completing late cannot deliver another result.
    const untilStopped = <T>(work: Promise<T>): Promise<T> => Promise.race([work, aborted])
    try {
      if (stopped) throw new Error('图片等待已结束')
      const channelId = args.channel_id as string
      const port = await untilStopped(deps.resolveChannelPort(channelId))
      if (!port) throw new Error('Channel 不可用')
      const capabilities = await untilStopped(deps.rpcClient.call<{}, { supports_image_fetch?: boolean }>(port, 'get_capabilities', {}, deps.moduleId))
      if (!capabilities.supports_image_fetch) throw new Error('该渠道不支持按需取图')
      const params: FetchImageParams = {
        session_id: args.session_id as string,
        platform_message_id: args.platform_message_id as string,
        quality: (args.quality ?? 'hd') as FetchImageParams['quality'],
      }
      while (!stopped) {
        const result = await untilStopped(deps.rpcClient.call<FetchImageParams, FetchImageResult>(port, 'fetch_image', params, deps.moduleId))
        if (result.status === 'failed') return result
        if (result.status === 'ready') {
          if (params.quality === 'hd' && result.image_quality !== 'hd') throw new Error('渠道未提供所请求的高清版本')
          return result
        }
        await delay(2_000, undefined, { signal: controller.signal })
      }
      throw new Error('图片等待已结束')
    } catch (error) {
      if (stopped) return { status: stopped, note: stopped === 'timed_out'
        ? '暂未取得高清版本；未证明上游下载失败，不必因此要求人类重发。后续需要时可重新获取。'
        : '本次取图等待已结束，无后台唤醒；如仍需要，可重新获取。' }
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timeout)
      if (interruption) clearInterval(interruption)
      context.abortSignal?.removeEventListener('abort', onAbort)
    }
  }
}
