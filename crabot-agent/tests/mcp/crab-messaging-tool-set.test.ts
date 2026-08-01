/**
 * worker 侧 messaging 工具集快照 —— 三种 profile 各自的**完整**工具名清单。
 *
 * 既有用例只逐个断言"某工具在/不在"，没有一处把整份清单钉死；工具集的决定权从
 * `buildMessagingTools` 内部提到装配层（PR C 第 1 步）时，这类局部断言不足以证明
 * "行为逐字不变"。本文件补上三份精确快照（飞书开/关各一组），任何一项多给或少给都会挂。
 *
 * daily_reflection 那份尤其重要：它是 2026-05-30 反思报告误发群事故的防线
 * （见 crab-messaging.ts 的 DAILY_REFLECTION_ALLOWED_TOOLS 注释）。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  ALL_MESSAGING_TOOL_NAMES,
  buildMessagingTools,
  buildWorkerMessagingTools,
} from '../../src/mcp/crab-messaging.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { TaskContext } from '../../src/mcp/crab-messaging.js'

const BARE_DEPS = {
  rpcClient: { call: vi.fn() } as never,
  moduleId: 'worker-test',
  getAdminPort: async () => 19001,
  resolveChannelPort: async () => 19009,
}

function toolNames(
  taskCtx: Pick<TaskContext, 'triggerType' | 'taskType'> | null,
  enableFeishuDocTool: boolean,
): string[] {
  const tools = buildWorkerMessagingTools({
    rpcClient: { call: vi.fn() } as never,
    moduleId: 'worker-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
    enableFeishuDocTool,
    ...(taskCtx
      ? {
          getTaskContext: () => ({
            taskId: 't1',
            humanQueue: new HumanMessageQueue(),
            hasGoal: () => false,
            ...taskCtx,
          }),
        }
      : {}),
  })
  return tools.map(t => t.name).sort()
}

const FEISHU_READ = ['feishu_download_file', 'feishu_raw_get', 'read_feishu_document']
const FEISHU_ALL = [...FEISHU_READ, 'feishu_write']

const HUMAN_MESSAGE_BASE = [
  'fetch_media',
  'get_history',
  'get_message',
  'list_contacts',
  'list_group_members',
  'list_groups',
  'list_sessions',
  'lookup_friend',
  'send_message',
]

const SCHEDULED_BASE = [...HUMAN_MESSAGE_BASE, 'send_master_private', 'send_private_message']

const DAILY_REFLECTION_BASE = ['get_history', 'get_message', 'send_master_private']

describe('worker messaging 工具集快照', () => {
  it('human_message（message 任务）', () => {
    expect(toolNames({ triggerType: 'message' }, false)).toEqual(HUMAN_MESSAGE_BASE.sort())
    expect(toolNames({ triggerType: 'message' }, true))
      .toEqual([...HUMAN_MESSAGE_BASE, ...FEISHU_ALL].sort())
  })

  it('human_message（front：无 task context）与 message 任务同集合', () => {
    expect(toolNames(null, false)).toEqual(HUMAN_MESSAGE_BASE.sort())
    expect(toolNames(null, true)).toEqual([...HUMAN_MESSAGE_BASE, ...FEISHU_ALL].sort())
  })

  it('human_message：taskType=daily_reflection 但 triggerType=message 时不套白名单', () => {
    expect(toolNames({ triggerType: 'message', taskType: 'daily_reflection' }, false))
      .toEqual(HUMAN_MESSAGE_BASE.sort())
  })

  it('scheduled（非 daily_reflection）', () => {
    expect(toolNames({ triggerType: 'scheduled', taskType: 'news_briefing' }, false))
      .toEqual(SCHEDULED_BASE.sort())
    expect(toolNames({ triggerType: 'scheduled', taskType: 'news_briefing' }, true))
      .toEqual([...SCHEDULED_BASE, ...FEISHU_ALL].sort())
    // taskType 缺省的 scheduled 任务同集合
    expect(toolNames({ triggerType: 'scheduled' }, false)).toEqual(SCHEDULED_BASE.sort())
  })

  it('scheduled_daily_reflection：唯一对外通道 send_master_private + 只读分析工具', () => {
    expect(toolNames({ triggerType: 'scheduled', taskType: 'daily_reflection' }, false))
      .toEqual(DAILY_REFLECTION_BASE.sort())
    // 飞书三件只读工具在白名单内；feishu_write 不在
    expect(toolNames({ triggerType: 'scheduled', taskType: 'daily_reflection' }, true))
      .toEqual([...DAILY_REFLECTION_BASE, ...FEISHU_READ].sort())
  })
})

describe('装配层声明', () => {
  it('buildMessagingTools 只给声明里的工具，多声明的名字不会凭空造出工具', () => {
    const tools = buildMessagingTools(
      { ...BARE_DEPS, enableFeishuDocTool: true },
      () => ({ tools: new Set(['get_history', 'send_message', '不存在的工具']), allowAskHuman: false }),
    )
    expect(tools.map(t => t.name).sort()).toEqual(['get_history', 'send_message'])
  })

  it('ALL_MESSAGING_TOOL_NAMES 与实际构造的工具一一对应（登记漏了 / 名字写错都会挂）', () => {
    const tools = buildMessagingTools(
      { ...BARE_DEPS, enableFeishuDocTool: true },
      () => ({ tools: new Set(ALL_MESSAGING_TOOL_NAMES), allowAskHuman: false }),
    )
    expect(tools.map(t => t.name).sort()).toEqual([...ALL_MESSAGING_TOOL_NAMES].sort())
  })
})
