/**
 * Manager 入站图片视觉注入 —— 恢复 P7 拆分时丢失的既有能力。
 *
 * 背景：worker trigger 流在 agent-handler（supportsVision → resolveImageBlocks →
 * ContentBlock[]）一直有图片注入；manager 的 envelope 装配路径从诞生起只搬了文本渲染，
 * 图片被拦成 `[图片: ...]` 文本标记，base64 从不进 LLM 请求——manager 模型明明是
 * VLM 却"看不到"用户发的图（2026-08-30 feishu 看图失败根因）。
 *
 * 数据流：channel 已把图片急切下载到本地（status=ready）。支持 base-protocol 的全部
 * 图片形态：media[]（权威，feishu 富文本多图）与遗留单图 media_url / file_path
 * （feishu 普通单图走 file_path，telegram/wechat 走 media_url）。
 * commitHumanInputs 提交人类消息时把引用记进 ManagerSessionState.imageRefs
 * （**轻量引用，不是 base64**——state.json 持久化且长期滚动，塞图片会撑爆）；
 * 构造 episode 输入时把窗口内命中引用的图片读盘转 ImageBlock 拼进 user message。
 *
 * **注入只存在于 LLM 请求投影**：runEngine 的 finalMessages 会原样回写 recent 与
 * episode log，loop 收尾必须用 injectInboundImages 返回的 originals 还原为注入前的
 * 纯文本消息再持久化，否则 base64 进 state.json/episodes/*.jsonl 无限放大。
 *
 * 文件不可读（被 media TTL GC 清理、超大小上限、IO 错误等）时：跳过该图注入，
 * 并把文本标记改写为中性提示，避免 LLM 拿着死路径/标记去瞎猜 fetch_media handle。
 * 失败原因不可区分（readImageFile 不区分 ENOENT/超限/权限），提示不承诺具体原因。
 */

import type { EngineMessage, ImageBlock } from '../engine/index.js'
import type { ChannelMessage } from '../types'
import { inferMediaType, readImageFile } from '../agent/media-resolver.js'

/** 单张入站图片的引用：path 是读盘用的本地路径，label 是 envelope 文本里的展示名。 */
export interface InboundImageRef {
  /** 本地可读路径（远程 URL 不收：manager 注入只读本地） */
  readonly path: string
  /**
   * envelope 文本里 `[图片: <label>]` 标记的展示名。必须与 media-resolver
   * formatMediaRef 的渲染字符串同源（media[] 形态 filename ?? media_url；
   * 遗留单图形态 media_url ?? filename ?? file_path），否则标记剔除/改写错位。
   */
  readonly label: string
}

/** state 里的人类消息图片引用：message_id 关联 recent 里 createUserMessage 的 id。 */
export interface ManagerImageRef {
  readonly message_id: string
  readonly images: ReadonlyArray<InboundImageRef>
}

/** 从一条 ChannelMessage 收集入站图片引用（media[] 权威，回退遗留单图形态）。 */
export function collectInboundImages(msg: ChannelMessage): InboundImageRef[] {
  const isLocal = (url: string): boolean => url !== '' && !url.startsWith('http://') && !url.startsWith('https://')
  const items = msg.content.media
  if (items && items.length > 0) {
    return items
      .filter((m) => m.mime_type.startsWith('image/'))
      .flatMap((m) => (isLocal(m.media_url) ? [{ path: m.media_url, label: m.filename ?? m.media_url }] : []))
  }
  if (msg.content.type === 'image') {
    // 遗留单图：formatMediaRef 渲染 media_url ?? filename ?? file_path;读盘取第一个本地路径
    const { media_url, filename, file_path } = msg.content
    const displayName = media_url ?? filename ?? file_path
    const readPath = [media_url, file_path].find((u): u is string => u !== undefined && isLocal(u))
    if (displayName && readPath) return [{ path: readPath, label: displayName }]
  }
  return []
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface InjectInboundImagesOptions {
  readonly supportsVision: boolean
  readonly imageRefs: ReadonlyArray<ManagerImageRef>
}

export interface InjectedInboundImages {
  /**
   * 注入后的消息（仅作 LLM 请求投影）。
   * 收尾持久化(recent/episode log)前必须用 originals 还原，base64 不得落盘。
   */
  readonly messages: EngineMessage[]
  /** id → 注入前的原始纯文本消息。finalMessages 里同 id 的消息用它还原。 */
  readonly originals: ReadonlyMap<string, EngineMessage>
}

/**
 * 对 episode 输入消息做图片注入变换：
 * - 命中 imageRefs 的 string user message → 读盘成功则 content 变为 [text, ...ImageBlock]，
 *   并剔除已注入图片的 `[图片: label]` 标记（与 worker 侧 initialPrompt 的处理对称）；
 * - 读盘失败（GC/超限/IO 等，原因不可区分）→ 标记改写为中性提示，不再注入；
 * - 未命中 / supportsVision=false / 非 string content → 原样返回该消息。
 */
export async function injectInboundImages(
  messages: ReadonlyArray<EngineMessage>,
  opts: InjectInboundImagesOptions,
): Promise<InjectedInboundImages> {
  if (!opts.supportsVision || opts.imageRefs.length === 0) {
    return { messages: [...messages], originals: new Map() }
  }
  const refsById = new Map(opts.imageRefs.map((r) => [r.message_id, r.images]))
  const originals = new Map<string, EngineMessage>()

  const injected = await Promise.all(
    messages.map(async (message): Promise<EngineMessage> => {
      // toolResults 消息的 role 也是 'user' 但无 content 字段,先排除
      if (message.role !== 'user' || !('content' in message) || typeof message.content !== 'string') return message
      const images = refsById.get(message.id)
      if (!images || images.length === 0) return message

      originals.set(message.id, message)
      let text = message.content
      const blocks: ImageBlock[] = []
      for (const image of images) {
        const marker = new RegExp(`\\[图片: ${escapeRegExp(image.label)}\\]\\n?`, 'g')
        const buffer = await readImageFile(image.path)
        if (!buffer) {
          // 文件不可读（已 GC / 超限 / IO）：改写标记防 LLM 瞎猜，不注入
          text = text.replace(marker, `[图片: ${image.label}（文件不可用，无法查看）]\n`)
          continue
        }
        text = text.replace(marker, '')
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: inferMediaType(undefined, image.path), data: buffer.toString('base64') },
        })
      }

      if (blocks.length === 0) return { ...message, content: text }
      return { ...message, content: [{ type: 'text' as const, text }, ...blocks] }
    }),
  )
  return { messages: injected, originals }
}

/**
 * 修剪 imageRefs：只保留 recent 里仍存在的消息引用。recent 滑动窗口/折叠裁掉的消息
 * 其引用成为死条目（磁盘垃圾，不影响行为——注入按 id 命中），在 episode 收尾保存前清掉。
 */
export function pruneImageRefs(
  imageRefs: ReadonlyArray<ManagerImageRef> | undefined,
  recent: ReadonlyArray<EngineMessage>,
): ReadonlyArray<ManagerImageRef> | undefined {
  if (!imageRefs || imageRefs.length === 0) return imageRefs
  const live = new Set(recent.map((m) => m.id))
  const kept = imageRefs.filter((r) => live.has(r.message_id) && r.images.length > 0)
  if (kept.length === imageRefs.length) return imageRefs
  return kept
}
