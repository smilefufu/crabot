/**
 * inbound-adapters —— 私聊 lane 批 / 群聊注意力 flush / harness 事件 → `WakeEvent` 的纯函数
 * 翻译层(protocol-agent-v3.md §4.1)。
 *
 * P4(Task 8)只把这三个纯函数备好、单测覆盖;**不**接线到 `SessionLaneRegistry`
 * (`orchestration/session-lane.ts`)/ `AttentionScheduler`(`orchestration/
 * attention-scheduler.ts`)/ `WorkerHarness.onEvent` ——那些调度器目前驱动的是
 * `unified-agent.ts` 的入站链路,P4 的"零现网影响"约束不允许改动它,真正接线要等 P7
 * cutover 那一刻把入站链路切到 `ManagerRegistry.routeXxx`。本文件因此不导入任何调度器/
 * harness 实例,只依赖类型,避免过早产生耦合。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.1
 */

import type { WakeEvent } from './loop.js'
import type { HarnessEvent, HarnessEventKind } from '../workers/harness/worker-events'
import type { ChannelMessage } from '../types'

/**
 * 私聊 lane 批(`SessionLaneRegistry<{ message: ChannelMessage }>` 的 `BatchHandler` 入参
 * 形状)→ `WakeEvent`。
 */
export function laneBatchToWakeEvent(batch: ReadonlyArray<{ message: ChannelMessage }>): WakeEvent {
  return { kind: 'human_messages', messages: batch.map((item) => item.message) }
}

/**
 * 群聊注意力 flush(`AttentionScheduler.FlushCallback` 触发的一批消息)→ `WakeEvent`。
 *
 * 注意力退避语义不在这里:`AttentionScheduler` 的 `reportResult(sessionId, replied)` 用于
 * 调整下次巡检间隔,调用方接线时仍须在 flush 回调里显式调用它——本函数只负责把这批消息
 * 翻译成 `WakeEvent` 本身,不吞掉、也不模拟这个退避回调。
 *
 * **接线请走 `ManagerRegistry.routeAttentionFlush`**(P7 J):那条路会一并解析发起人身份
 * 并把 `friend` 带进 `WakeEvent`,而本函数只做形状翻译、不带身份。
 */
export function attentionFlushToWakeEvent(msgs: ReadonlyArray<ChannelMessage>): WakeEvent {
  return { kind: 'attention_flush', messages: msgs }
}

/** 审计档事件（protocol-agent-v3 §4.1 两档分层）：只落 events.jsonl，永不唤醒 manager。
 *  `input_sent`——manager 自己发起 send_to_worker 时已经在同一次工具调用里同步拿到了投递结果，
 *  不需要再靠事件唤醒一次去获知"已发送"这件事本身；`legacy_imported` 只是 cutover 历史记录。
 *  其余 kind 都是唤醒档：worker 生命周期/交互/巡检/侧问的进展或终局，manager 需要据此决定
 *  要不要转述给人类或采取下一步动作。 */
const NO_WAKE_KINDS: ReadonlySet<HarnessEventKind> = new Set(['input_sent', 'legacy_imported'])

/** harness 事件是否值得唤醒 manager(过滤规则见 `NO_WAKE_KINDS` 注释)。 */
export function shouldWakeOnHarnessEvent(e: HarnessEvent): boolean {
  return !NO_WAKE_KINDS.has(e.kind)
}
