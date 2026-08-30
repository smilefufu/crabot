/**
 * Manager 入站图片视觉注入 —— 恢复 P7 拆分时丢失的既有能力。
 *
 * 背景：worker trigger 流在 agent-handler（supportsVision → resolveImageBlocks →
 * ContentBlock[]）一直有图片注入；manager 的 envelope 装配路径从诞生起只搬了文本渲染，
 * 图片被拦成 `[图片: filename]` 文本标记，base64 从不进 LLM 请求——manager 模型明明是
 * VLM 却"看不到"用户发的图（2026-08-30 feishu 看图失败根因）。
 *
 * 数据流：channel 已把图片急切下载到本地（status=ready，media_url=本地路径）。
 * commitHumanInputs 提交人类消息时把路径引用记进 ManagerSessionState.imageRefs
 * （**轻量引用，不是 base64**——state.json 持久化且长期滚动，塞图片会撑爆）；
 * 构造 episode 输入时把窗口内命中引用的图片读盘转 ImageBlock 拼进 user message。
 *
 * 文件已被 media TTL GC 清理（feishu 默认 7 天，会话却可能活几周）时：跳过该图注入，
 * 并把文本标记改写为过期提示，避免 LLM 拿着死路径/标记去瞎猜 fetch_media handle。
 */

import type { EngineMessage, ImageBlock } from '../engine/index.js'
import type { ChannelMessage } from '../types'
import { inferMediaType, readImageFile } from '../agent/media-resolver.js'

/** state 里的人类消息图片引用：message_id 关联 recent 里 createUserMessage 的 id。 */
export interface ManagerImageRef {
  readonly message_id: string
  readonly paths: ReadonlyArray<string>
}

/** 从一条 ChannelMessage 收集入站图片的本地路径（远程 URL 不收：manager 注入只读本地）。 */
export function collectInboundImagePaths(msg: ChannelMessage): string[] {
  const items = msg.content.media
  if (!items || items.length === 0) return []
  return items
    .filter((m) => m.mime_type.startsWith('image/'))
    .map((m) => m.media_url)
    .filter((url) => url !== '' && !url.startsWith('http://') && !url.startsWith('https://'))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface InjectInboundImagesOptions {
  readonly supportsVision: boolean
  readonly imageRefs: ReadonlyArray<ManagerImageRef>
}

/**
 * 对 episode 输入消息做图片注入变换：
 * - 命中 imageRefs 的 string user message → 读盘成功则 content 变为 [text, ...ImageBlock]，
 *   并剔除已注入图片的 `[图片: filename]` 标记行（与 worker 侧 initialPrompt 的处理对称）；
 * - 读盘失败（文件已 GC）→ 标记改写为「文件已清理，无法查看」，不再注入；
 * - 未命中 / supportsVision=false / 非 string content → 原样返回该消息。
 */
export async function injectInboundImages(
  messages: ReadonlyArray<EngineMessage>,
  opts: InjectInboundImagesOptions,
): Promise<EngineMessage[]> {
  if (!opts.supportsVision || opts.imageRefs.length === 0) return [...messages]
  const refsById = new Map(opts.imageRefs.map((r) => [r.message_id, r.paths]))

  return Promise.all(
    messages.map(async (message): Promise<EngineMessage> => {
      // toolResults 消息的 role 也是 'user' 但无 content 字段,先排除
      if (message.role !== 'user' || !('content' in message) || typeof message.content !== 'string') return message
      const paths = refsById.get(message.id)
      if (!paths || paths.length === 0) return message

      let text = message.content
      const blocks: ImageBlock[] = []
      for (const p of paths) {
        const filename = p.split('/').pop() ?? p
        const marker = new RegExp(`\\[图片: ${escapeRegExp(filename)}\\]\\n?`, 'g')
        const buffer = await readImageFile(p)
        if (!buffer) {
          // 文件已被 TTL GC 清理：改写标记防 LLM 瞎猜，不注入
          text = text.replace(marker, `[图片: ${filename}（文件已清理，无法查看）]\n`)
          continue
        }
        text = text.replace(marker, '')
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: inferMediaType(undefined, p), data: buffer.toString('base64') },
        })
      }

      if (blocks.length === 0) return { ...message, content: text }
      return { ...message, content: [{ type: 'text' as const, text }, ...blocks] }
    }),
  )
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
  const kept = imageRefs.filter((r) => live.has(r.message_id) && r.paths.length > 0)
  if (kept.length === imageRefs.length) return imageRefs
  return kept
}
