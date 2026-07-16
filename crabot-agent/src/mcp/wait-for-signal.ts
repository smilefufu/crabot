/**
 * wait_for_signal 工具：通用挂起原语（targets 结构化声明版）。
 *
 * 适用场景：
 * 1) worker 派出了 async subagent（delegate_task），等它完成（target kind='subagent'）；
 * 2) worker 起了会转后台的 bash（命令超 10s 自动转后台），等它退出（kind='bg_entity'）；
 * 3) 等 crabot 系统之外的事件（PR review / 远端构建 / 页面状态），系统无法感知、
 *    只能定时唤醒后由 agent 主动检查（kind='external'，timeout_ms 即轮询间隔）。
 *
 * 准入规则（spec 2026-07-16-wait-signal-targets-goal-lifecycle-design §5）：
 * - targets 必填；subagent / bg_entity 目标不存在 → 立即拒绝（带不带 timeout_ms 都拒绝）
 * - external 必须带 timeout_ms
 * - audit / human_reply 不是合法等待对象（定向教育文案）
 *
 * 硬不变量（§5.2）：targets 只做准入校验，不做唤醒过滤——挂起后任何 humanQueue push
 * （用户实时纠偏、无关 shell 退出、系统通知）都立即唤醒。严禁改成"只有目标事件才唤醒"，
 * 否则实时纠偏注入链路会断。
 *
 * 实现：复用 humanQueue.setBarrier 机制（跟 ask_human 同一套 barrier 路径）。
 * 超时消息用挂起时刻的快照——若期间有对象退出必然已 push 唤醒、超时不会触发，
 * 所以挂起时快照在超时时仍准确，无需异步查询。
 */

import { z } from 'zod'
import type { HumanMessageQueue } from '../engine/human-message-queue.js'
import type { ToolCallContext, ToolDefinition, ToolCallResult } from '../engine/types.js'

/**
 * 兜底超时：跟 ASK_HUMAN_BARRIER_TIMEOUT_MS 一致（24 小时）。
 * Agent 不感知此 timeout——只要有 push 就会被 clearBarrier 唤醒。
 */
export const WAIT_FOR_SIGNAL_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** timeout_ms 下限：防止 LLM 传毫秒级小值把挂起退化成空转 */
export const WAIT_FOR_SIGNAL_MIN_TIMEOUT_MS = 1_000

/** 连续 external 超时达到此次数后，超时文案追加"收尾 + schedule 复查"引导（spec §5.3） */
export const EXTERNAL_TIMEOUT_GUIDANCE_THRESHOLD = 3

/** 在跑对象快照条目——唤醒/超时消息的展示单元。 */
export interface RunningWaitTarget {
  readonly id: string
  readonly kind: 'subagent' | 'bg_entity'
  /** 已运行毫秒数（可选，快照展示用） */
  readonly runtime_ms?: number
  /** 命令 / 任务摘要（可选） */
  readonly description?: string
}

export interface WaitForSignalDeps {
  readonly humanQueue: HumanMessageQueue
  /** 本 task 在跑的 async subagent id 列表（准入校验 + 快照）。 */
  readonly listActiveAsyncSubagentIds: () => ReadonlyArray<string>
  /** 本 task 名下 running 的 bg shell 列表。查 bgRegistry，故异步。 */
  readonly listRunningBgEntities: () => Promise<ReadonlyArray<RunningWaitTarget>>
}

function formatRuntime(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m${sec % 60 > 0 ? `${sec % 60}s` : ''}`
}

/**
 * 把在跑对象列表格式化为唤醒消息里的"仍在运行"快照行。
 * subagent 完成通知 / bg shell 退出通知 push 时由 harness 现查现写（无新状态）——
 * agent 醒来即知还剩什么在跑，不依赖它对自身历史行为的记忆（spec §6）。
 * 空列表返回空串（调用方直接拼接即可）。
 */
export function formatStillRunningSnapshot(items: ReadonlyArray<RunningWaitTarget>): string {
  if (items.length === 0) return ''
  const parts = items.map((i) => {
    const details: string[] = []
    if (i.description) details.push(i.description.slice(0, 60))
    if (i.runtime_ms !== undefined) details.push(`已跑 ${formatRuntime(i.runtime_ms)}`)
    return `${i.id}${details.length > 0 ? `（${details.join('，')}）` : ''}`
  })
  return `仍在运行：${parts.join('、')}。全部完成前如无其他工作，请继续 wait_for_signal。`
}

// zod 侧多收 audit / human_reply 两个非法 kind——不是为了放行，而是为了在 handler 里
// 给出定向教育文案（比 schema 通用报错有效得多；schema 报错模型只会换个写法重试）。
const targetSchema = z.object({
  kind: z.enum(['subagent', 'bg_entity', 'external', 'audit', 'human_reply']),
  id: z.string().optional(),
})

const inputSchema = z.object({
  reason: z.string().describe('挂起原因（trace 可读），如 "等 code_writer 完成"'),
  targets: z.array(targetSchema).min(1),
  timeout_ms: z.number().int().positive().optional(),
})

const TOOL_DESCRIPTION =
  '挂起当前任务，等待外部异步事件唤醒。必须声明你在等什么（targets）：' +
  "1) {kind:'subagent'}——等 delegate_task 派出的异步 subagent 完成（可选 id 精确指定）；" +
  "2) {kind:'bg_entity'}——等后台 shell 退出（命令超 10s 自动转后台；可选 id）；" +
  "3) {kind:'external'}——等 crabot 系统之外的事件（PR review / 远端构建 / 页面状态变化），" +
  '必须带 timeout_ms 作为轮询间隔：系统无法感知外部事件，到点唤醒你后你必须自己主动检查外部状态，' +
  '未到再挂下一轮。如有命令行 watcher 可用（如 gh pr checks --watch），优先起后台 shell 等它退出。' +
  '注意：交付审计不需要也无法等待——系统在你 end_turn 时自动挂起等审；' +
  '等人类回复用 send_message(intent=\'ask_human\')。' +
  '挂起后任何事件（用户消息 / 其他 shell 退出）都会唤醒你，醒来先处理事件再决定是否继续等。'

export function createWaitForSignalTool(deps: WaitForSignalDeps): ToolDefinition {
  // 连续 external 超时计数（工具实例 = 单个 worker loop 生命周期）。
  // 只增不减：无法观测"push 唤醒 vs 超时唤醒"，宁可多提示不漏提示。
  let externalTimeoutStreak = 0

  return {
    name: 'wait_for_signal',
    description: TOOL_DESCRIPTION,
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '挂起原因（trace 可读）' },
        targets: {
          type: 'array',
          minItems: 1,
          description: '你在等待的对象列表；每一项都必须真实存在，否则会被拒绝',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['subagent', 'bg_entity', 'external'],
                description: 'subagent=异步子代理完成 | bg_entity=后台 shell 退出 | external=系统外部事件（必带 timeout_ms 定时自查）',
              },
              id: { type: 'string', description: '可选：精确指定 subagent/bg_entity 的 entity id' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
        timeout_ms: {
          type: 'integer',
          description: '最长等待毫秒数，超时自动唤醒（注入 [wait_timeout] 标记）。external 目标必带（作为轮询间隔）。',
        },
      },
      required: ['reason', 'targets'],
      additionalProperties: false,
    },
    call: async (rawInput: Record<string, unknown>, _context: ToolCallContext): Promise<ToolCallResult> => {
      const parseResult = inputSchema.safeParse(rawInput)
      if (!parseResult.success) {
        return { isError: true, output: `invalid input: ${parseResult.error.message}` }
      }
      const { reason, targets, timeout_ms } = parseResult.data

      // 优先级最高：队列已有事件 → 不挂起，先处理
      if (deps.humanQueue.hasPending) {
        return {
          isError: false,
          output: '已有 pending 唤醒事件，无需再次挂起；请继续处理队列中的事件。',
        }
      }

      // 准入校验：每个声明的目标都必须合法且存在（spec §5.1）
      const subagentIds = deps.listActiveAsyncSubagentIds()
      let bgEntities: ReadonlyArray<RunningWaitTarget> | undefined
      for (const target of targets) {
        switch (target.kind) {
          case 'audit':
            return {
              isError: true,
              output:
                '交付审计由系统在你 end_turn 时自动触发并等待，你不需要、也无法主动等待它。'
                + '请直接继续工作；都做完了就 end_turn，系统会自动挂起等审并唤醒你。',
            }
          case 'human_reply':
            return {
              isError: true,
              output:
                "等待人类回复请用 send_message(intent='ask_human')——它会正确挂起任务并等待回复送达；"
                + 'wait_for_signal 不用于此场景。',
            }
          case 'subagent': {
            if (target.id !== undefined) {
              if (!subagentIds.includes(target.id)) {
                return {
                  isError: true,
                  output:
                    `目标 subagent ${target.id} 不存在或已完成——你可能在等一个不会到来的事件。`
                    + `已完成的结果用 get_subagent_output("${target.id}") 读取；否则请继续其他工作或 end_turn。`,
                }
              }
            } else if (subagentIds.length === 0) {
              return {
                isError: true,
                output:
                  '当前没有在跑的 async subagent，目标不存在——你可能在等一个不会到来的事件。'
                  + '如已收到完成通知，用 get_subagent_output 读取结果；否则请继续其他工作或 end_turn。',
              }
            }
            break
          }
          case 'bg_entity': {
            bgEntities = bgEntities ?? await deps.listRunningBgEntities()
            if (target.id !== undefined) {
              if (!bgEntities.some((e) => e.id === target.id)) {
                return {
                  isError: true,
                  output:
                    `目标 bg entity ${target.id} 不存在或已退出——你可能在等一个不会到来的事件。`
                    + `输出用 Output("${target.id}") 读取；在跑清单用 ListEntities 查看。`,
                }
              }
            } else if (bgEntities.length === 0) {
              return {
                isError: true,
                output:
                  '当前没有运行中的后台 shell，目标不存在——你可能在等一个不会到来的事件。'
                  + '如需查看已退出 shell 的输出用 Output(entity_id)；否则请继续其他工作或 end_turn。',
              }
            }
            break
          }
          case 'external': {
            if (timeout_ms === undefined) {
              return {
                isError: true,
                output:
                  'external 目标必须带 timeout_ms（作为轮询间隔）：系统无法感知外部事件，'
                  + '只能定时唤醒你，由你主动检查外部状态（gh / curl 等），未到再挂下一轮。',
              }
            }
            break
          }
        }
      }

      // 挂起时刻快照——超时时若有对象退出必然已 push 唤醒（超时不会触发），
      // 所以这份快照在超时消息里仍准确。
      const hasExternal = targets.some((t) => t.kind === 'external')
      const targetEcho = targets.map((t) => {
        if (t.kind === 'external') return '外部事件（需你主动检查）'
        return `${t.id ?? `任一 ${t.kind === 'subagent' ? 'async subagent' : '后台 shell'}`}`
      }).join('、')

      const buildTimeoutMessage = (waitedSec: number): string => {
        if (hasExternal) externalTimeoutStreak++
        const lines = [
          `[wait_timeout] 等待超时（${reason}，已等 ${waitedSec}s），无外部事件到达。`,
          `挂起时声明的等待对象：${targetEcho}——未推送退出事件的对象通常仍在运行。`,
        ]
        if (hasExternal) {
          lines.push('external 目标请立即主动检查外部状态，未到再挂下一轮。')
          if (externalTimeoutStreak >= EXTERNAL_TIMEOUT_GUIDANCE_THRESHOLD) {
            lines.push(
              '外部等待已连续多次超时——跨天级的等待不适合挂起轮询，'
              + '考虑收尾本任务并创建 schedule 定时复查任务。',
            )
          }
        }
        lines.push('如需继续等，可再次调用 wait_for_signal。')
        return lines.join('\n')
      }

      if (timeout_ms !== undefined) {
        const clamped = Math.min(Math.max(timeout_ms, WAIT_FOR_SIGNAL_MIN_TIMEOUT_MS), WAIT_FOR_SIGNAL_TIMEOUT_MS)
        const waitedSec = Math.round(clamped / 1000)
        deps.humanQueue.setBarrier(clamped, () => {
          deps.humanQueue.push(buildTimeoutMessage(waitedSec))
        })
        return {
          isError: false,
          output: `已挂起等待 (${reason}，对象：${targetEcho})；最长 ${waitedSec}s，期间任何事件 push 都会提前唤醒。`,
        }
      }

      deps.humanQueue.setBarrier(WAIT_FOR_SIGNAL_TIMEOUT_MS)
      return {
        isError: false,
        output: `已挂起等待 (${reason}，对象：${targetEcho})；下次 push 唤醒后继续。`,
      }
    },
  }
}
