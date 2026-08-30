/**
 * Manager 入站图片视觉注入 —— 恢复 P7 拆分时丢失的既有能力。
 *
 * 背景：worker trigger 流在 agent-handler（supportsVision → resolveImageBlocks →
 * ContentBlock[]）一直有图片注入；manager 的 envelope 装配路径从诞生起只搬了文本渲染，
 * 图片被拦成 `[图片: ...]` 文本标记，base64 从不进 LLM 请求——manager 模型明明是
 * VLM 却"看不到"用户发的图（2026-08-30 feishu 看图失败根因）。
 *
 * 数据流：支持 base-protocol 的全部图片形态——media[]（权威，feishu 富文本多图）、
 * 遗留单图 media_url / file_path（feishu 普通单图走 file_path，telegram/wechat 走
 * media_url=公网 CDN 地址，worker 侧 fetchRemoteImage 一直支持下载）。本地路径优先，
 * 远程 URL 走 fetch。commitHumanInputs 提交人类消息时把引用记进
 * ManagerSessionState.imageRefs（**轻量引用，不是 base64**——state.json 持久化且
 * 长期滚动，塞图片会撑爆）；构造 episode 输入时把窗口内命中引用的图片读盘/下载
 * 转 ImageBlock 拼进 user message。
 *
 * **注入只存在于 LLM 请求投影**：runEngine 的 finalMessages 会原样回写 recent 与
 * episode log，loop 收尾必须用 injectInboundImages 返回的 originals 还原为注入前的
 * 纯文本消息再持久化，否则 base64 进 state.json/episodes/*.jsonl 无限放大。
 *
 * 来源不可读（被 media TTL GC 清理、超大小上限、下载失败、IO 错误等）时：跳过该图
 * 注入，并把文本标记改写为中性提示，避免 LLM 拿着死路径/标记去瞎猜 fetch_media
 * handle。失败原因不可区分（readImageFile/fetchRemoteImage 均不区分具体错误），
 * 提示不承诺具体原因。
 */

import type { EngineMessage, ImageBlock } from '../engine/index.js'
import type { ChannelMessage } from '../types'
import { inferMediaType, readImageFile, fetchRemoteImage } from '../agent/media-resolver.js'

/** 单张入站图片的引用：path 是本地路径或可 GET 的远程 URL，label 是 envelope 文本里的展示名。 */
export interface InboundImageRef {
  /**
   * 读取来源：本地路径（readImageFile）或远程 URL（fetchRemoteImage，微信渠道的
   * media_url=resource_url 即公网 CDN 地址）。本地优先——同图两者都有时读盘无网络失败面。
   */
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

/**
 * 兼容 29a25d08（已在 main）写出的旧 imageRefs 结构 `{message_id, paths: string[]}`：
 * 读时归一化为 images 形态，label 退化为 path 原样。升级窗口过后可删。
 */
export function normalizeImageRefs(raw: ReadonlyArray<ManagerImageRef> | undefined): ReadonlyArray<ManagerImageRef> | undefined {
  if (!raw) return raw
  let changed = false
  const out = raw.map((r) => {
    if (r.images) return r
    changed = true
    const paths = (r as { paths?: ReadonlyArray<string> }).paths
    return { message_id: r.message_id, images: paths?.map((p) => ({ path: p, label: p })) ?? [] }
  })
  return changed ? out : raw
}

/** 从一条 ChannelMessage 收集入站图片引用（media[] 权威，回退遗留单图形态）。 */
export function collectInboundImages(msg: ChannelMessage): InboundImageRef[] {
  const items = msg.content.media
  if (items && items.length > 0) {
    return items
      .filter((m) => m.mime_type.startsWith('image/') && m.media_url !== '')
      .map((m) => ({ path: m.media_url, label: m.filename ?? m.media_url }))
  }
  if (msg.content.type === 'image') {
    // 遗留单图：formatMediaRef 渲染 media_url ?? filename ?? file_path;
    // 读取来源本地优先(media_url/file_path 都可能存在,读盘无网络失败面)
    const { media_url, filename, file_path } = msg.content
    const displayName = media_url ?? filename ?? file_path
    const readPath = file_path ?? media_url
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
        const isRemote = image.path.startsWith('http://') || image.path.startsWith('https://')
        const buffer = isRemote ? await fetchRemoteImage(image.path) : await readImageFile(image.path)
        if (!buffer) {
          // 来源不可读（已 GC / 超限 / 下载失败 / IO，原因不可区分）：改写标记防 LLM 瞎猜，不注入
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
