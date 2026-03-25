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
     *   4. 等待 Agent 回复（通过 Promise）后返回
     *
     * Agent 回复后，ChannelHost.handleSendMessage 调用 deliver → dispatcher.sendFinalReply
     * → 实际发送到平台
     *
     * 重要：必须等待 Agent 回复后才返回，否则某些插件（如 @larksuite/openclaw-lark）
     * 会在 dispatchReplyFromConfig 返回后立即设置 dispatchFullyComplete 标志，
     * 导致 Agent 回复时 deliver 被跳过。
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

      console.log(`[Shim] dispatchReplyFromConfig: sessionId=${sessionId}, dispatcher.sendFinalReply exists=${!!params.dispatcher.sendFinalReply}`)

      // 创建一个 Promise，在 Agent 回复后 resolve
      let resolveReply: () => void
      const replyPromise = new Promise<void>((resolve) => {
        resolveReply = resolve
      })

      // 封装 deliver fn：调用插件的 dispatcher.sendFinalReply，并在完成后 resolve
      const deliver: DeliverFn = async (payload, _info) => {
        console.log(`[Shim] deliver called: text="${(payload.text ?? '').slice(0, 50)}...", kind=${_info?.kind}`)
        try {
          if (params.dispatcher.sendFinalReply) {
            // 传递完整 payload（包含 text, mediaUrl, filename 等）
            console.log('[Shim] deliver: calling dispatcher.sendFinalReply')
            await params.dispatcher.sendFinalReply(payload)
            console.log('[Shim] deliver: dispatcher.sendFinalReply returned')
          } else {
            console.error('[Shim] deliver: dispatcher.sendFinalReply is not available!')
          }
        } finally {
          // Agent 回复完成，resolve Promise
          resolveReply()
        }
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

      // 等待 Agent 回复
      console.log('[Shim] dispatchReplyFromConfig: waiting for Agent reply...')
      await replyPromise
      console.log('[Shim] dispatchReplyFromConfig: Agent reply completed')

      return { queuedFinal: 1, counts: { tool: 0, block: 0, final: 1 } }
    },

    /**
     * 高级插件的分发流程包装器
     *
     * 在 OpenClaw 原版中，withReplyDispatcher 管理 dispatcher 的生命周期：
     * 1. 调用 run()
     * 2. 调用 dispatcher.markComplete() 标记不再接收新消息
     * 3. 等待 dispatcher.waitForIdle()（所有排队的消息发送完毕）
     * 4. 调用 onSettled()
     *
     * 在 Shim 中：run() 会立即返回（dispatchReplyFromConfig 不等待 Agent 回复），
     * 但我们需要延迟 markComplete 直到 Agent 真正回复。
     * 这里先不做任何生命周期管理，让 Agent 回复时通过 deliver 完成发送。
     */
    async withReplyDispatcher(params: {
      dispatcher: {
        markComplete?: () => void
        waitForIdle?: () => Promise<void>
      }
      run: () => Promise<unknown>
      onSettled?: () => void
    }): Promise<unknown> {
      try {
        return await params.run()
      } finally {
        // 注意：不调用 markComplete() 和 waitForIdle()
        // 因为 Agent 的回复是异步的，dispatchReplyFromConfig 返回时消息还没处理完。
        // onSettled 也不调用，因为消息还没 settled。
        // 当 Agent 回复并调用 deliver 时，消息才算处理完成。
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
      let isComplete = false
      let callCount = 0

      return {
        dispatcher: {
          async sendFinalReply(payload: unknown) {
            callCount++
            console.log(`[Shim] sendFinalReply called (#${callCount}), isComplete=${isComplete}, payload text length=${String((payload as { text?: string }).text ?? '').length}`)

            // 防止重复调用
            if (isComplete) {
              console.log('[Shim] sendFinalReply: skipped (dispatcher already complete)')
              return
            }
            try {
              console.log('[Shim] sendFinalReply: calling onReplyStart')
              await onReplyStart?.()
              const p = payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] }
              console.log(`[Shim] sendFinalReply: calling deliver with text="${(p.text ?? '').slice(0, 50)}..."`)
              // 传递完整的 payload 和 info
              await deliver(
                { text: p.text, mediaUrl: p.mediaUrl, mediaUrls: p.mediaUrls },
                { kind: 'final' }
              )
              console.log('[Shim] sendFinalReply: deliver completed')
              await onIdle?.()
              console.log('[Shim] sendFinalReply: onIdle completed')
            } catch (err) {
              console.error('[Shim] sendFinalReply error:', err)
              await onError?.(err, { kind: 'final' })
            }
            // 注意：不在这里调用 onCleanup，让飞书的生命周期管理正常工作
          },
          async sendBlockReply(payload: unknown) {
            if (isComplete) return
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
          markComplete: () => {
            console.log('[Shim] markComplete called')
            isComplete = true
            onCleanup?.()
          },
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
