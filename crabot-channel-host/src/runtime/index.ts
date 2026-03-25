/**
 * runtime/index.ts - 组装注入给插件的完整 channelRuntime
 *
 * 这个对象的结构对应 OpenClaw 的 PluginRuntime 接口（channel.*），
 * 但所有 LLM 相关路径都被我们的 Shim 实现替换：
 *   - channel.reply.dispatchReplyWithBufferedBlockDispatcher — 简单插件入口
 *   - channel.reply.dispatchReplyFromConfig               — 高级插件入口（feishu 等）
 *   - channel.reply.withReplyDispatcher                   — 高级插件流程包装器
 *
 * 其余函数（text.*、session.*、pairing.* 等）提供合理的 stub 实现，
 * 保证插件不会因缺少方法而崩溃。
 */

import type { MsgContext, DeliverFn } from '../types.js'
import type { PendingDispatchMap } from '../pending-dispatch.js'
import { createReplyRuntime } from './reply.js'
import { routingRuntime } from './routing.js'
import { runtimeStubs } from './stubs.js'

export function createChannelRuntime(
  pendingDispatches: PendingDispatchMap,
  onMessageReceived: (ctx: MsgContext, sessionId: string) => Promise<void>,
  pluginConfig?: unknown
): unknown {
  const reply = createReplyRuntime(pendingDispatches, onMessageReceived)

  return {
    channel: {
      reply,
      routing: routingRuntime,
      text: runtimeStubs.text,
      session: runtimeStubs.session,
      pairing: runtimeStubs.pairing,
      debounce: runtimeStubs.debounce,
      media: runtimeStubs.media,
      activity: runtimeStubs.activity,
      mentions: runtimeStubs.mentions,
      reactions: runtimeStubs.reactions,
      groups: runtimeStubs.groups,
      commands: runtimeStubs.commands,
      // 平台特定（feishu 等高级插件可能访问，提供 stub 防止崩溃）
      discord: runtimeStubs.discord,
      slack: runtimeStubs.slack,
      telegram: runtimeStubs.telegram,
      signal: runtimeStubs.signal,
      imessage: runtimeStubs.imessage,
      whatsapp: runtimeStubs.whatsapp,
      line: runtimeStubs.line,
    },
    // 插件配置加载（feishu 插件通过 LarkClient.runtime.config.loadConfig() 访问）
    config: {
      loadConfig: () => pluginConfig ?? {},
    },
    // OpenClaw PluginRuntime 接口的其他属性
    system: runtimeStubs.system,
    events: runtimeStubs.events,
    logging: runtimeStubs.logging,
    state: runtimeStubs.state,
    modelAuth: runtimeStubs.modelAuth,
    tts: runtimeStubs.tts,
    stt: runtimeStubs.stt,
    tools: runtimeStubs.tools,
    media: runtimeStubs.mediaRuntime,
    subagent: runtimeStubs.subagent,
  }
}

export type { DeliverFn }
