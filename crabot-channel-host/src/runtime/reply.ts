/**
 * runtime/reply.ts - ★ 核心桥接
 *
 * 替换 OpenClaw 内置的 LLM 分发函数，不调用任何 LLM，
 * 而是将消息路由到 Crabot Agent。
 *
 * 支持两种 OpenClaw 插件风格：
 *
 * 1. 简单风格（zalo、googlechat、synology-chat 等）：
 *    core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ ctx, cfg, dispatcherOptions })
 *
 * 2. 高级风格（feishu、telegram、whatsapp 等）：
 *    core.channel.reply.withReplyDispatcher({
 *      dispatcher,
 *      run: () => core.channel.reply.dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions })
 *    })
 */

import type { MsgContext, DeliverFn } from '../types.js'
import type { PendingDispatchMap } from '../pending-dispatch.js'
import { randomUUID } from 'node:crypto'

export function createReplyRuntime(
  pendingDispatches: PendingDispatchMap,
  onMessageReceived: (ctx: MsgContext, sessionId: string) => Promise<void>
) {
  return {
    // ── 简单风格 ────────────────────────────────────────────────────────────
    /**
     * 简单插件的分发入口（zalo、googlechat、synology-chat 等）
     * 插件直接传入 { ctx, cfg, dispatcherOptions: { deliver } }
     */
    async dispatchReplyWithBufferedBlockDispatcher(params: {
      ctx: MsgContext
      cfg: unknown
      dispatcherOptions: { deliver: DeliverFn }
    }): Promise<void> {
      const sessionId = params.ctx.SessionKey ?? params.ctx.SenderId ?? randomUUID()

      pendingDispatches.set(sessionId, { deliver: params.dispatcherOptions.deliver })
      onMessageReceived(params.ctx, sessionId).catch((error: unknown) => {
        console.error('[ChannelHost] onMessageReceived error:', error)
      })
    },

    // ── 高级风格 ────────────────────────────────────────────────────────────
    /**
     * 高级插件的分发入口（feishu、telegram、whatsapp 等）
     *
     * 在 OpenClaw 原版中，此函数调用 LLM 并通过 dispatcher 发送回复。
     * 在 Shim 中：
     *   1. 从 ctx 提取 sessionId（ctx.SessionKey）
     *   2. 将 dispatcher.sendFinalReply 封装为 deliver fn 并存入 pendingDispatches
     *   3. 触发 onMessageReceived（发布 channel.message_received 事件）
     *   4. 立即返回（不调用 LLM）
     *
     * Agent 回复后，ChannelHost.handleSendMessage 调用 deliver → dispatcher.sendFinalReply
     * → 实际发送到平台
     */
    async dispatchReplyFromConfig(params: {
      ctx: Record<string, unknown>
      cfg: unknown
      dispatcher: {
        sendFinalReply?: (payload: unknown, opts?: unknown) => Promise<void>
        sendBlockReply?: (payload: unknown) => Promise<void>
        markComplete?: () => void
      }
      replyOptions?: unknown
    }): Promise<{ queuedFinal: number; counts: { tool: number; block: number; final: number } }> {
      const ctx = params.ctx
      const sessionId =
        (ctx.SessionKey as string | undefined) ??
        (ctx.SenderId as string | undefined) ??
        randomUUID()

      // 封装 deliver fn：调用插件的 dispatcher.sendFinalReply
      const deliver: DeliverFn = async (payload, _info) => {
        if (params.dispatcher.sendFinalReply) {
          await params.dispatcher.sendFinalReply({ text: payload.text })
        }
        params.dispatcher.markComplete?.()
      }

      pendingDispatches.set(sessionId, { deliver })

      // 将 ctx 适配为 MsgContext（取常用字段，其余 fallback 到空）
      const msgCtx: MsgContext = {
        SenderId: ctx.SenderId as string | undefined,
        SenderName: ctx.SenderName as string | undefined,
        SenderUsername: ctx.SenderUsername as string | undefined,
        SessionKey: ctx.SessionKey as string | undefined,
        AccountId: ctx.AccountId as string | undefined,
        Provider: ctx.Provider as string | undefined,
        Body: (ctx.Body ?? ctx.body) as string | undefined,
        RawBody: ctx.RawBody as string | undefined,
        ChatType: ctx.ChatType as string | undefined,
      }

      onMessageReceived(msgCtx, sessionId).catch((error: unknown) => {
        console.error('[ChannelHost] onMessageReceived error:', error)
      })

      return { queuedFinal: 0, counts: { tool: 0, block: 0, final: 0 } }
    },

    /**
     * 高级插件的分发流程包装器
     *
     * 在 OpenClaw 原版中，withReplyDispatcher 管理 dispatcher 的生命周期。
     * 在 Shim 中：直接调用 run()（其中会调用我们的 dispatchReplyFromConfig），
     * 然后调用 onSettled。
     */
    async withReplyDispatcher(params: {
      dispatcher: unknown
      run: () => Promise<unknown>
      onSettled?: () => void
    }): Promise<unknown> {
      try {
        return await params.run()
      } finally {
        params.onSettled?.()
      }
    },

    /**
     * 创建 dispatcher 对象（包装 deliver 函数）
     *
     * 在 OpenClaw 原版中，此函数添加打字指示、人类延迟等效果。
     * 在 Shim 中：直接透传 deliver，不添加额外延迟。
     *
     * 返回的 dispatcher 会被传入 dispatchReplyFromConfig。
     */
    createReplyDispatcherWithTyping(params: {
      deliver: DeliverFn
      onReplyStart?: () => void | Promise<void>
      onIdle?: () => void | Promise<void>
      onCleanup?: () => void
      onError?: (error: unknown, info: unknown) => void | Promise<void>
      humanDelay?: unknown
      responsePrefix?: unknown
      responsePrefixContextProvider?: unknown
    }): {
      dispatcher: {
        sendFinalReply: (payload: unknown, opts?: unknown) => Promise<void>
        sendBlockReply: (payload: unknown) => Promise<void>
        sendToolResult: () => boolean
        waitForIdle: () => Promise<void>
        getQueuedCounts: () => { tool: number; block: number; final: number }
        markComplete: () => void
      }
      replyOptions: Record<string, unknown>
      markDispatchIdle: () => void
    } {
      const { deliver, onReplyStart, onIdle, onCleanup, onError } = params

      return {
        dispatcher: {
          async sendFinalReply(payload: unknown) {
            try {
              await onReplyStart?.()
              const p = payload as { text?: string; mediaUrl?: string }
              await deliver({ text: p.text, mediaUrl: p.mediaUrl }, { kind: 'final' })
              await onIdle?.()
            } catch (err) {
              await onError?.(err, { kind: 'final' })
            } finally {
              onCleanup?.()
            }
          },
          async sendBlockReply(payload: unknown) {
            try {
              const p = payload as { text?: string }
              await deliver({ text: p.text }, { kind: 'block' })
            } catch (err) {
              await onError?.(err, { kind: 'block' })
            }
          },
          sendToolResult: () => false,
          waitForIdle: async () => { await onIdle?.() },
          getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
          markComplete: () => { onCleanup?.() },
        },
        replyOptions: {},
        markDispatchIdle: () => { void onIdle?.() },
      }
    },

    // Stub：不需要 LLM 调用的辅助函数
    resolveHumanDelayConfig: () => null,
    resolveEffectiveMessagesConfig: () => ({}),
    finalizeInboundContext: (ctx: unknown) => ctx,
    formatAgentEnvelope: () => '',
    formatInboundEnvelope: () => '',
    resolveEnvelopeFormatOptions: () => ({}),
    dispatchReplyFromConfig_raw: undefined,  // 内部占位，不对外暴露
  }
}
