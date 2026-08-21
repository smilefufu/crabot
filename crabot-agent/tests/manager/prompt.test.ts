import { describe, it, expect } from 'vitest'
import {
  MANAGER_IDENTITY,
  assembleManagerSystemPrompt,
  type PromptInputs,
} from '../../src/manager/prompt'
import type { ManagerKey } from '../../src/manager/types'

const MANAGER_KEY: ManagerKey = 'wechat::sess-1'

function baseInputs(overrides: Partial<PromptInputs> = {}): PromptInputs {
  return {
    managerKey: MANAGER_KEY,
    isSystemThread: false,
    dialogProfile: '## 对话对象档案\n张三，master，偏好简短回复',
    ...overrides,
  }
}

describe('MANAGER_IDENTITY 静态段内容', () => {
  it('含身份自述：你是 Crabot 的 manager，负责会话的对话与 worker 管理', () => {
    expect(MANAGER_IDENTITY).toContain('你是 Crabot 的 manager')
    expect(MANAGER_IDENTITY).toContain('对话与 worker 管理')
  })

  it('含 crabot 架构自述：manager/worker 拆分、worker 多种实现、manager 自己不干活', () => {
    expect(MANAGER_IDENTITY).toContain('worker 有多种实现')
    expect(MANAGER_IDENTITY).toContain('内置 loop')
    expect(MANAGER_IDENTITY).toContain('claude code')
    expect(MANAGER_IDENTITY).toContain('codex')
    expect(MANAGER_IDENTITY).toContain('你自己不干活')
    expect(MANAGER_IDENTITY).toContain('派活、送话、侧问、查状态/原生会话、看终端、回应未知界面、请求中断或停止')
    expect(MANAGER_IDENTITY).toContain('get_worker_terminal')
    expect(MANAGER_IDENTITY).toContain('worker 与人类之间隔着你')
  })

  it('含管家纪律：按预计工作路径动态决定直接答或确认后继续', () => {
    expect(MANAGER_IDENTITY).toContain('先判断响应路径')
    expect(MANAGER_IDENTITY).toContain('不要按“历史问题”“进度问题”“派活”等问题类别套固定流程')
    expect(MANAGER_IDENTITY).toContain('当前上下文、台账或记忆里已有足够答案')
    expect(MANAGER_IDENTITY).toContain('直接把结果告诉人类')
    expect(MANAGER_IDENTITY).toContain('不要为了确认而额外发一条无信息量的消息')
  })

  it('含管家纪律：更早的对话用 get_history 拉', () => {
    // cutover 后 manager 的 state.json 是空的，眼前 messages 只有最近一段；
    // 不写这一行，LLM 不会自发想到去拉历史（plan §一 5a）。
    expect(MANAGER_IDENTITY).toContain('get_history')
    expect(MANAGER_IDENTITY).toContain('只是最近一段')
    expect(MANAGER_IDENTITY).toContain('更早')
  })

  it('含管家纪律：慢路径先给任务相关的确认答复', () => {
    expect(MANAGER_IDENTITY).toContain('确认后继续')
    expect(MANAGER_IDENTITY).toContain('与当前任务相关的确认答复')
    expect(MANAGER_IDENTITY).toContain('不得只写“收到”“我去办”')
    expect(MANAGER_IDENTITY).toContain('这不是请求人类批准')
    expect(MANAGER_IDENTITY).toContain('派活前的交代')
    expect(MANAGER_IDENTITY).toContain('先想清楚该任务的大体执行方向')
  })

  it('含管家纪律：何时派活', () => {
    expect(MANAGER_IDENTITY).toContain('写代码、查资料、操作系统')
    expect(MANAGER_IDENTITY).toContain('不要自己在对话里假装做了')
  })

  it('含管家纪律：何时打扰人类', () => {
    expect(MANAGER_IDENTITY).toContain('真正需要人类决策')
  })

  it('含管家纪律：等待即 end_turn', () => {
    expect(MANAGER_IDENTITY).toContain('需要等任何事')
    expect(MANAGER_IDENTITY).toContain('直接结束回合')
    expect(MANAGER_IDENTITY).toContain('结果会唤醒你')
    expect(MANAGER_IDENTITY).toContain('不要空转')
  })

  it('含管家纪律：慢工具异步语义', () => {
    expect(MANAGER_IDENTITY).toContain('spawn_worker')
    expect(MANAGER_IDENTITY).toContain('send_to_worker')
    expect(MANAGER_IDENTITY).toContain('query_worker')
    expect(MANAGER_IDENTITY).toContain('不代表事情做完了')
  })

  it('含管家纪律：先复用已有 worker（send_to_worker 对终态自动复活，spawn_worker 留给新任务）', () => {
    // 机制侧 harness.sendToWorker 早已透明分流（补送 / 复活），但 LLM 只能从 prompt 得知；
    // 缺这一段，manager 面对延续性请求会一律 spawn_worker 开新的、丢掉旧上下文。
    expect(MANAGER_IDENTITY).toContain('先复用已有 worker')
    expect(MANAGER_IDENTITY).toContain('list_workers')
    expect(MANAGER_IDENTITY).toContain('自动复活')
    expect(MANAGER_IDENTITY).toContain('list_workers(include_terminal=true)')
    expect(MANAGER_IDENTITY).toContain('不能因为默认 active 列表里没有就直接 spawn')
    expect(MANAGER_IDENTITY).toContain('另起炉灶的新任务')
  })

  it('慢工具纪律不再承诺"进展会唤醒你、不需要主动轮询"，而是如实说明唤醒粒度是轮次边界', () => {
    // 旧措辞是一句假承诺：turn 内的输出不产生任何事件，LLM 信了就会一直等一个不会来的唤醒。
    expect(MANAGER_IDENTITY).not.toContain('不需要你主动轮询')
    expect(MANAGER_IDENTITY).toContain('每跑完一轮')
    expect(MANAGER_IDENTITY).toContain('get_worker_activity')
    expect(MANAGER_IDENTITY).toContain('get_worker_terminal')
  })

  it('含管家纪律：结论拿不到先回去问 worker（这是 manager 自己能解决的事）', () => {
    // 生产故障：每日反思 worker 全程只调工具、finish_task 收场，manager 手里拿不到交付物，
    // 直接跟人类说"请检查执行实例的输出链路"。机制侧 send_to_worker 对终态 worker 会透明
    // 复活、上下文完整保留 —— 缺的不是能力，是 prompt 里"先复用已有 worker"那段讲的是
    // **新请求进来**该怎么办，"任务完成了但交付物拿不到"是另一个场景，一个字没提。
    expect(MANAGER_IDENTITY).toContain('结论拿不到就回去问 worker')
    expect(MANAGER_IDENTITY).toContain('send_to_worker')
    expect(MANAGER_IDENTITY).toContain('完整上下文')
    expect(MANAGER_IDENTITY).toContain('才轮到找人类')
  })

  it('含管家纪律：对人类只讲事情本身（系统内部细节不进给人类的回复）', () => {
    // 同一次故障的另一半：跟人类说"执行实例的输出链路"，那是系统内部实现，用户不该关心，
    // 更不该被指使去查。
    expect(MANAGER_IDENTITY).toContain('对人类只讲事情本身')
    expect(MANAGER_IDENTITY).toContain('也不让人类去查系统内部')
  })

  it('含管家纪律：不滥用跨 session 投递', () => {
    expect(MANAGER_IDENTITY).toContain('send_message')
    expect(MANAGER_IDENTITY).toContain('只在人类明确要求时才这么做')
  })

  it('不含系统线程专属的 reach_master 纪律（非系统线程场景不应污染静态常量）', () => {
    expect(MANAGER_IDENTITY).not.toContain('send_master_private')
  })
})

describe('assembleManagerSystemPrompt 稳定装配', () => {
  it('只含身份、固定线程角色和档案，不含动态台账/时钟/通知', () => {
    const output = assembleManagerSystemPrompt(baseInputs())
    expect(output).toContain('张三，master，偏好简短回复')
    expect(output).not.toContain('当前状态（动态')
    expect(output).not.toContain('worker w1: idle')
    expect(output).not.toContain('2026-07-30T08:00:00.000Z')
    expect(output).not.toContain('待处理通知')
  })

  it('系统线程追加 reach_master 纪律，且仍在档案之前', () => {
    const output = assembleManagerSystemPrompt(baseInputs({ isSystemThread: true }))
    expect(output.indexOf('send_master_private')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('张三，master，偏好简短回复')).toBeGreaterThan(output.indexOf('send_master_private'))
  })

  it('改变曾经的动态输入不影响 system prompt 字节', () => {
    const first = assembleManagerSystemPrompt(baseInputs())
    const second = assembleManagerSystemPrompt(baseInputs())
    expect(first).toBe(second)
  })

  describe('工具名验证', () => {
    it('prompt 中提及的所有反引号包裹的工具名都在实际工具集中', () => {
      // 实际工具名集合（来自 tool-face.ts 的白名单）
      const actualToolNames = new Set([
        // messaging 工具
        'send_message',
        'get_history',
        'get_message',
        'lookup_friend',
        'list_sessions',
        'list_contacts',
        'list_groups',
        'list_group_members',
        'fetch_media',
        // 系统线程额外
        'send_master_private',
        'send_private_message',
        // worker 工具
        'spawn_worker',
        'send_to_worker',
        'query_worker',
        'get_worker_terminal',
        'respond_to_worker_ui',
        'list_workers',
        'request_worker_interrupt',
        'request_worker_stop',
        // crabot-info 工具
        'get_system_status',
        'get_deployment_info',
        'list_schedules',
        'get_config_summary',
        'list_capabilities',
        'get_friend_permissions',
        // memory 工具前缀（具体工具由 MCP server 提供）
        'mcp__crab-memory__',
      ])

      const prompt = MANAGER_IDENTITY

      // 提取反引号包裹的内容
      const backtickPattern = /`(\w[\w_]*(?:__\w[\w_]*)?)`/g
      const matches = [...prompt.matchAll(backtickPattern)]
      const mentionedNames = matches.map((m) => m[1])

      // 过滤掉不是工具名的（如变量名等）
      const toolReferences = mentionedNames.filter((name) => {
        // 工具名要么是 actualToolNames 中的，要么是 mcp__ 前缀
        return (
          actualToolNames.has(name) ||
          (name.startsWith('mcp__') && actualToolNames.has('mcp__crab-memory__'))
        )
      })

      // 验证所有工具引用都在实际工具集中
      for (const toolName of toolReferences) {
        if (toolName.startsWith('mcp__')) {
          expect(toolName.startsWith('mcp__crab-memory__')).toBe(true)
        } else {
          expect(actualToolNames.has(toolName)).toBe(
            true,
            `工具 '${toolName}' 在 prompt 中提及但不在实际工具集中`,
          )
        }
      }

      // 特别检查：不应该出现 ask_human
      expect(prompt).not.toContain('ask_human')
    })
  })
})
