import { describe, it, expect } from 'vitest'
import { assembleDispatcherPrompt } from '../../src/dispatcher/dispatcher-prompt.js'
import type { DispatchContext } from '../../src/dispatcher/dispatcher-types.js'
import type { TaskSummary } from '../../src/types.js'

function task(id: string): TaskSummary {
  return {
    task_id: id as never,
    title: `t-${id}`,
    status: 'executing',
    priority: 'normal',
  }
}

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    messages: [], recentMessages: [], activeTasks: [], sessionType: 'private',
    channelId: 'c', sessionId: 's',
    senderFriend: { id: 'f', display_name: 'u', permission: 'master' } as never,
    traceId: 't', ...overrides,
  }
}

describe('assembleDispatcherPrompt', () => {
  it('包含产品自我认知（Crabot 相关措辞）', () => {
    const p = assembleDispatcherPrompt(ctx())
    expect(p).toMatch(/Crabot/)
  })

  it('群聊场景 + 有可补充任务 → 三种动作都暴露', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'group', activeTasks: [task('task-A')] }))
    expect(p).toMatch(/supplement/)
    expect(p).toMatch(/new_task/)
    expect(p).toMatch(/stay_silent/)
  })

  it('私聊场景下不暴露 stay_silent 选项', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [task('task-A')] }))
    expect(p).not.toMatch(/stay_silent/)
  })

  it('包含 JSON 输出 schema 与软上限 5', () => {
    const p = assembleDispatcherPrompt(ctx())
    expect(p).toMatch(/actions/)
    expect(p).toMatch(/5/)
  })

  it('不包含主工作流相关段（MCP 工具列表 / Skill / 反模式 self-check）', () => {
    const p = assembleDispatcherPrompt(ctx())
    expect(p).not.toMatch(/MCP|skill|ghost-promise|context hallucination|effortful synthesis/i)
  })

  // ============================================================================
  // Regression: candidate list 为空时不向 LLM 暴露 supplement 选项
  // 修复来源：trace db206eaf — group 会话首条消息（无任何 active task），LLM 仍
  // 凭空输出 supplement + 编造 trigger-<uuid> 的 target_task_id。根因是 prompt
  // 仍把 supplement 描述为合法选项，加上 schema 只校验类型不校验白名单。
  // ============================================================================

  it('空 candidate list + 私聊 → prompt 完全不含 supplement 字串', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [] }))
    expect(p).not.toMatch(/supplement/)
    expect(p).toMatch(/new_task/)
    // 提示语应说明没有可补充任务
    expect(p).toMatch(/没有任何可补充任务/)
  })

  it('空 candidate list + 群聊 → prompt 完全不含 supplement 字串，但保留 stay_silent', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'group', activeTasks: [] }))
    expect(p).not.toMatch(/supplement/)
    expect(p).toMatch(/new_task/)
    expect(p).toMatch(/stay_silent/)
    expect(p).toMatch(/没有任何可补充任务/)
    // SYSTEM_EVENT_GUIDANCE 段也必须按 hasActiveTasks=false 走精简路径，不出 supplement
    expect(p).toContain('## 群系统事件')
  })

  it('非空 candidate list → prompt 含白名单硬约束提醒（防 LLM 编造 task_id）', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [task('task-A')] }))
    expect(p).toMatch(/target_task_id 硬约束/)
    expect(p).toMatch(/字面完全一致/)
    expect(p).toMatch(/可补充任务/)
  })

  it('空 candidate list → 不显示白名单提醒（没有 supplement 选项时不需要）', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [] }))
    expect(p).not.toMatch(/target_task_id 硬约束/)
  })

  // ============================================================================
  // Regression: 多 bot 群里 prompt 必须显式注入自身 @handle
  // 触发场景：telegram 群里同时挂 @fufu_ai_001_bot / @fufu_ai_002_bot 两个 crabot
  // 实例，master 一条消息分别给两个 bot 各派一个角色——dispatcher prompt 缺自身
  // handle 时 LLM 只能瞎猜，结果把发给对方 bot 的指令当成自己的并写进 scene_profile。
  // ============================================================================

  it('注入 crabSelfHandle 时 prompt 含自身 @handle 段', () => {
    const p = assembleDispatcherPrompt(ctx({ crabSelfHandle: '@fufu_ai_001_bot' }))
    expect(p).toContain('## 你在本渠道的身份')
    expect(p).toContain('@fufu_ai_001_bot')
    // 必须明确告诉 LLM：消息正文里别的 @xxx 是发给别人的
    expect(p).toMatch(/出现.*@fufu_ai_001_bot.*才是.*@.*你|@fufu_ai_001_bot.*表示在 @ 你/)
  })

  it('未注入 crabSelfHandle 时不渲染身份段（保持向后兼容）', () => {
    const p = assembleDispatcherPrompt(ctx())
    expect(p).not.toContain('## 你在本渠道的身份')
  })

  it('包含 SLASH_AWARENESS_GUIDANCE 段', () => {
    const p = assembleDispatcherPrompt(ctx())
    expect(p).toContain('## 系统 slash 指令认知')
    expect(p).toContain('/目标 <task-id>')
    expect(p).toContain('/清除目标 <task-id>')
  })

  it('OUTPUT_SCHEMA 在空 activeTasks 时只列出允许的 kind', () => {
    const pPrivate = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [] }))
    // schema 段应表明 1 种合法 kind
    expect(pPrivate).toMatch(/1 种之一/)
    expect(pPrivate).toMatch(/`new_task`/)
    expect(pPrivate).not.toMatch(/`supplement`/)

    const pGroup = assembleDispatcherPrompt(ctx({ sessionType: 'group', activeTasks: [] }))
    expect(pGroup).toMatch(/2 种之一/)
    expect(pGroup).toMatch(/`new_task`/)
    expect(pGroup).toMatch(/`stay_silent`/)
    expect(pGroup).not.toMatch(/`supplement`/)
  })

  it('群聊场景注入 SYSTEM_EVENT_GUIDANCE，私聊不注入', () => {
    const pGroup = assembleDispatcherPrompt(ctx({ sessionType: 'group' }))
    expect(pGroup).toContain('## 群系统事件')
    expect(pGroup).toContain('event="members_added"')
    expect(pGroup).toContain('不要 echo 内部黑话')
    // 指引必须明确 LLM 怎么透传 open_id 给下游 worker
    expect(pGroup).toContain('[event_affected_users]')
    expect(pGroup).toContain('open_id')

    const pPrivate = assembleDispatcherPrompt(ctx({ sessionType: 'private' }))
    expect(pPrivate).not.toContain('## 群系统事件')
  })

  it('SYSTEM_EVENT_GUIDANCE 把 supplement / new_task / stay_silent 三条路径都呈现给 LLM', () => {
    // 关键：dispatcher prompt 不能让 LLM 觉得 system_event 只有 new_task 一条路。
    // 场景画像里 master 可能把事件绑定到进行中的 task（supplement）、要求开新动作（new_task），
    // 或没写任何规则（stay_silent）。
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'group', activeTasks: [task('task-A')] }))
    const sysEventSection = p.slice(p.indexOf('## 群系统事件'))
    expect(sysEventSection).toMatch(/supplement/)
    expect(sysEventSection).toMatch(/new_task/)
    expect(sysEventSection).toMatch(/stay_silent/)
  })

  it('SYSTEM_EVENT_GUIDANCE 不教 dispatcher 调 send_message 的 mentions 参数（那是 worker 的事）', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'group' }))
    const sysEventSection = p.slice(p.indexOf('## 群系统事件'))
    expect(sysEventSection).not.toMatch(/mentions/)
    expect(sysEventSection).not.toMatch(/send_message.*参数/)
  })

  // ============================================================================
  // immediate_reply 字段指引（spec: 2026-06-03-dispatcher-immediate-reply-and-overdue-removal-design.md）
  //
  // immediate_reply 是 new_task 字段，guidance 直接塞在 new_task 描述里，
  // 不另开 section——避免重复段占 token。
  // ============================================================================

  it('immediate_reply 指引嵌在 new_task 字段说明里（不开独立 section）', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private' }))
    expect(p).toContain('immediate_reply（可选）')
    // 不应该有独立的 section 标题
    expect(p).not.toContain('## new_task 的可选预回复')
    expect(p).not.toContain('## immediate_reply')
  })

  it('immediate_reply 指引含核心信号 + 文案约束', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private' }))
    const sec = p.slice(p.indexOf('immediate_reply（可选）'))
    // 倾向带的信号
    expect(sec).toMatch(/动词|调研|多步骤/)
    // 倾向不带的信号
    expect(sec).toMatch(/寒暄|在吗|谢谢/)
    // 拿不准 → 不带
    expect(sec).toMatch(/拿不准/)
    // 文案约束
    expect(sec).toMatch(/30 字/)
    expect(sec).toMatch(/不承诺时间|不承诺/)
    expect(sec).toMatch(/内部术语/)
  })

  it('immediate_reply 指引在所有 dispatch rule 变体里都出现', () => {
    // private with active / private no active / group with active / group no active
    const pPrivWith = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [task('T')] }))
    const pPrivNo = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [] }))
    const pGroupWith = assembleDispatcherPrompt(ctx({ sessionType: 'group', activeTasks: [task('T')] }))
    const pGroupNo = assembleDispatcherPrompt(ctx({ sessionType: 'group', activeTasks: [] }))
    for (const p of [pPrivWith, pPrivNo, pGroupWith, pGroupNo]) {
      expect(p).toContain('immediate_reply（可选）')
    }
  })

  it('SYSTEM_EVENT_GUIDANCE 含 immediate_reply 默认不带的特例', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'group' }))
    const sec = p.slice(p.indexOf('## 群系统事件'))
    expect(sec).toMatch(/immediate_reply 默认不带|immediate_reply.*不该带/)
  })

  it('OUTPUT_SCHEMA 的 new_task 示例含 immediate_reply 字段', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private' }))
    expect(p).toMatch(/"immediate_reply":/)
  })
})
