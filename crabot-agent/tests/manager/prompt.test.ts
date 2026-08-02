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
    dynamic: {
      ledgerRender: '- worker w1: idle',
      nowIso: '2026-07-30T08:00:00.000Z',
      pendingNotes: ['worker w1 已完成'],
    },
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
    expect(MANAGER_IDENTITY).toContain('派活、送话、侧问、看输出、终止')
    expect(MANAGER_IDENTITY).toContain('worker 与人类之间隔着你')
  })

  it('含管家纪律：何时代答', () => {
    expect(MANAGER_IDENTITY).toContain('记忆')
    expect(MANAGER_IDENTITY).toContain('对话历史')
    expect(MANAGER_IDENTITY).toContain('台账')
    expect(MANAGER_IDENTITY).toContain('不要为了确认去打扰人类')
    expect(MANAGER_IDENTITY).toContain('worker 停下来问的问题')
  })

  it('含管家纪律：更早的对话用 get_history 拉', () => {
    // cutover 后 manager 的 state.json 是空的，眼前 messages 只有最近一段；
    // 不写这一行，LLM 不会自发想到去拉历史（plan §一 5a）。
    expect(MANAGER_IDENTITY).toContain('get_history')
    expect(MANAGER_IDENTITY).toContain('只是最近一段')
    expect(MANAGER_IDENTITY).toContain('更早')
  })

  it('含管家纪律：要花时间的事先回一句收到（sendImmediateReply 放弃后的替代）', () => {
    expect(MANAGER_IDENTITY).toContain('先回一句')
    expect(MANAGER_IDENTITY).toContain('收到')
    expect(MANAGER_IDENTITY).toContain('再动手')
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

  it('含管家纪律：不滥用跨 session 投递', () => {
    expect(MANAGER_IDENTITY).toContain('send_message')
    expect(MANAGER_IDENTITY).toContain('只在人类明确要求时才这么做')
  })

  it('不含系统线程专属的 reach_master 纪律（非系统线程场景不应污染静态常量）', () => {
    expect(MANAGER_IDENTITY).not.toContain('send_master_private')
  })
})

describe('assembleManagerSystemPrompt 装配顺序', () => {
  it('静态段 → 档案 → 动态块，顺序正确', () => {
    const output = assembleManagerSystemPrompt(baseInputs())

    const identityIdx = output.indexOf('你是 Crabot 的 manager')
    const profileIdx = output.indexOf('张三，master，偏好简短回复')
    const dynamicIdx = output.indexOf('worker w1: idle')

    expect(identityIdx).toBeGreaterThanOrEqual(0)
    expect(profileIdx).toBeGreaterThan(identityIdx)
    expect(dynamicIdx).toBeGreaterThan(profileIdx)
  })

  it('动态块包含 ledgerRender / nowIso / pendingNotes', () => {
    const output = assembleManagerSystemPrompt(baseInputs())

    expect(output).toContain('worker w1: idle')
    expect(output).toContain('2026-07-30T08:00:00.000Z')
    expect(output).toContain('worker w1 已完成')
  })

  it('无 dialogProfile 时不装配档案段，静态段仍在动态块之前', () => {
    const output = assembleManagerSystemPrompt(baseInputs({ dialogProfile: undefined }))

    const identityIdx = output.indexOf('你是 Crabot 的 manager')
    const dynamicIdx = output.indexOf('worker w1: idle')

    expect(identityIdx).toBeGreaterThanOrEqual(0)
    expect(dynamicIdx).toBeGreaterThan(identityIdx)
  })

  it('系统线程 manager 额外含 reach_master 纪律段（例行留本线程，仅需人类立即注意才 reach_master）', () => {
    const systemOutput = assembleManagerSystemPrompt(baseInputs({ isSystemThread: true }))
    const nonSystemOutput = assembleManagerSystemPrompt(baseInputs({ isSystemThread: false }))

    expect(systemOutput).toContain('send_master_private')
    expect(systemOutput).toContain('例行成功留在本线程')
    expect(systemOutput).toContain('需要人类立即注意')
    expect(nonSystemOutput).not.toContain('send_master_private')
  })

  it('系统线程的 reach_master 纪律段位于静态段区域，仍在档案/动态块之前', () => {
    const output = assembleManagerSystemPrompt(baseInputs({ isSystemThread: true }))

    const reachMasterIdx = output.indexOf('send_master_private')
    const profileIdx = output.indexOf('张三，master，偏好简短回复')
    const dynamicIdx = output.indexOf('worker w1: idle')

    expect(reachMasterIdx).toBeGreaterThanOrEqual(0)
    expect(profileIdx).toBeGreaterThan(reachMasterIdx)
    expect(dynamicIdx).toBeGreaterThan(profileIdx)
  })

  describe('前缀稳定性：只改 dynamic 时，输出的动态块之前部分逐字节不变', () => {
    it('非系统线程', () => {
      const inputsA = baseInputs()
      const inputsB = baseInputs({
        dynamic: {
          ledgerRender: '- worker w2: running\n- worker w3: exited',
          nowIso: '2026-07-30T09:30:00.000Z',
          pendingNotes: ['worker w2 卡住了', 'worker w3 已完成'],
        },
      })

      const outputA = assembleManagerSystemPrompt(inputsA)
      const outputB = assembleManagerSystemPrompt(inputsB)

      const dynamicMarker = '张三，master，偏好简短回复'
      const cutA = outputA.indexOf(dynamicMarker) + dynamicMarker.length
      const cutB = outputB.indexOf(dynamicMarker) + dynamicMarker.length

      const prefixA = outputA.slice(0, cutA)
      const prefixB = outputB.slice(0, cutB)

      // 前缀长度也必须一致——不允许在动态块之前插入任何随 dynamic 变化的内容
      expect(outputA.length - prefixA.length).not.toBe(0)
      expect(prefixA).toBe(prefixB)
    })

    it('系统线程', () => {
      const inputsA = baseInputs({ isSystemThread: true })
      const inputsB = baseInputs({
        isSystemThread: true,
        dynamic: {
          ledgerRender: '- worker wA: idle',
          nowIso: '2026-07-30T23:59:00.000Z',
        },
      })

      const outputA = assembleManagerSystemPrompt(inputsA)
      const outputB = assembleManagerSystemPrompt(inputsB)

      const dynamicMarker = '张三，master，偏好简短回复'
      const cutA = outputA.indexOf(dynamicMarker) + dynamicMarker.length
      const cutB = outputB.indexOf(dynamicMarker) + dynamicMarker.length

      const prefixA = outputA.slice(0, cutA)
      const prefixB = outputB.slice(0, cutB)

      expect(prefixA).toBe(prefixB)
    })

    it('pendingNotes 缺省 vs 存在，不影响动态块之前的前缀', () => {
      const withNotes = assembleManagerSystemPrompt(baseInputs())
      const withoutNotes = assembleManagerSystemPrompt(
        baseInputs({ dynamic: { ledgerRender: '- worker w1: idle', nowIso: '2026-07-30T08:00:00.000Z' } }),
      )

      const dynamicMarker = '张三，master，偏好简短回复'
      const cutWith = withNotes.indexOf(dynamicMarker) + dynamicMarker.length
      const cutWithout = withoutNotes.indexOf(dynamicMarker) + dynamicMarker.length

      expect(withNotes.slice(0, cutWith)).toBe(withoutNotes.slice(0, cutWithout))
    })

    it('添加 managerKey 后，仅改 dynamic 时前缀仍逐字节不变', () => {
      const inputsA = baseInputs()
      const inputsB = baseInputs({
        dynamic: {
          ledgerRender: '- worker w2: running',
          nowIso: '2026-07-30T09:30:00.000Z',
        },
      })

      const outputA = assembleManagerSystemPrompt(inputsA)
      const outputB = assembleManagerSystemPrompt(inputsB)

      const dynamicMarker = '当前状态（动态，不进缓存前缀）'
      const cutA = outputA.indexOf(dynamicMarker)
      const cutB = outputB.indexOf(dynamicMarker)

      const prefixA = outputA.slice(0, cutA)
      const prefixB = outputB.slice(0, cutB)

      expect(prefixA).toBe(prefixB)
    })
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
        'read_worker_output',
        'list_workers',
        'kill_worker',
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
