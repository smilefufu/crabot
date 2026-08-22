/**
 * 统一 Agent system prompt 装配函数。
 *
 * 装配顺序：
 *   [adminPersonality?] → 大脑身份 → [sceneProfile?] → 对话边界 →
 *   工作流（buildWorkflow，含 [目标承诺] 段位仅 goalModeEnabled 时注入）→
 *   send_message 规范 → end_turn self-check → 时间感知 → 信息查询指引 →
 *   工具使用规范 → 任务推进硬约束 → [GOAL_MODE_DETAILS 仅 goalModeEnabled 时注入] →
 *   slash 指令认知 → 记忆存储指引 → 收尾责任 → [skillListing?] → [subAgents?]
 *
 * Spec: crabot-docs/superpowers/specs/2026-06-05-goal-soft-control-workflow-redesign-design.md §3 §5
 */

import {
  CRABOT_BRAIN_IDENTITY,
  SYSTEM_DIALOGUE_BOUNDARY,
  buildWorkflow,
  SEND_MESSAGE_SPEC,
  END_TURN_SELF_CHECK,
  TIME_AWARENESS,
  INFO_QUERY_GUIDE,
  TOOL_USAGE,
  TASK_HARD_CONSTRAINTS,
  GOAL_MODE_DETAILS,
  SLASH_AWARENESS_GUIDANCE,
  MEMORY_STORE_GUIDE,
  CLOSURE_DUTIES,
  buildImageCapability,
} from './agent-sections.js'

export interface AssembleAgentPromptOptions {
  readonly goalModeEnabled: boolean
  readonly adminPersonality?: string
  readonly sceneProfile?: { readonly label: string; readonly content: string }
  readonly skillListing?: string
  readonly availableSubAgents?: ReadonlyArray<{
    readonly toolName: string
    readonly workerHint: string
  }>
  /** Worker only has delegate_task, not AgentHandler's subagent coordinator tools. */
  readonly subagentGuidance?: 'agent' | 'builtin_worker'
  readonly imageCapability?: { readonly available: boolean }
}

function escapeSceneProfileContent(content: string): string {
  return content.replace(/<\/scene_profile>/g, '&lt;/scene_profile&gt;')
}

export function assembleAgentPrompt(opts: AssembleAgentPromptOptions): string {
  const parts: string[] = []

  if (opts.adminPersonality) {
    parts.push(opts.adminPersonality)
  }

  parts.push(CRABOT_BRAIN_IDENTITY)

  if (opts.sceneProfile) {
    const escaped = escapeSceneProfileContent(opts.sceneProfile.content)
    parts.push(
      `## 场景画像\n<scene_profile label="${opts.sceneProfile.label}">\n${escaped}\n</scene_profile>`,
    )
  }

  parts.push(SYSTEM_DIALOGUE_BOUNDARY)
  parts.push(buildWorkflow(opts.goalModeEnabled))
  parts.push(SEND_MESSAGE_SPEC)
  parts.push(END_TURN_SELF_CHECK)
  parts.push(TIME_AWARENESS)
  parts.push(INFO_QUERY_GUIDE)
  parts.push(TOOL_USAGE)
  parts.push(buildImageCapability(opts.imageCapability?.available ?? false))
  parts.push(TASK_HARD_CONSTRAINTS)
  if (opts.goalModeEnabled) {
    parts.push(GOAL_MODE_DETAILS)
  }
  parts.push(SLASH_AWARENESS_GUIDANCE)
  parts.push(MEMORY_STORE_GUIDE)
  parts.push(CLOSURE_DUTIES)

  if (opts.skillListing) {
    parts.push(opts.skillListing)
  }

  if (opts.availableSubAgents && opts.availableSubAgents.length > 0) {
    const list = opts.availableSubAgents
      .map(a => `- ${a.toolName}：${a.workerHint}`)
      .join('\n')
    parts.push(
      `## 可用的专项 Sub-agent\n\n` +
      `你可以将子任务委派给以下专项 Sub-agent，它们在独立上下文中执行，只返回最终结果：\n${list}\n\n` +
      `适合委派的场景：\n` +
      `1. 你的能力不足以完成某个子任务（如你没有视觉能力但需要分析图片）\n` +
      `2. 子任务的中间过程你不关心，只需要最终结果（避免污染你的上下文）`,
    )
    parts.push(opts.subagentGuidance === 'builtin_worker' ? BUILTIN_WORKER_SUBAGENT_GUIDANCE : ASYNC_SUBAGENT_GUIDANCE)
  }

  return parts.join('\n\n')
}

const ASYNC_SUBAGENT_GUIDANCE = `## 异步 Subagent（默认行为）

调 \`delegate_task\` **默认异步**：工具立即返回 \`{agent_id, status:"launched"}\`，不阻塞你。

**派出后你可以做的事：**
- 同 turn 内再 batch 调多次 \`delegate_task\` 并发派更多 subagent
- 用 \`send_message\` 告诉用户"我已派出 N 个子任务"
- 然后 end_turn 等通知

**通知回流机制：**
subagent 完成时，系统自动推送 \`<sub_agent_notification>\` 到你的下一轮 turn。
用户的任何 supplement（进度询问、改方向、取消）也会同步回流——你不会被长任务卡住。

**通知中包含：**
- agent_id（可用来读取全文或 stop）
- status（completed / failed）
- result_preview（成功时**内联结果预览**）：没有 \`truncated="true"\` 就是完整结果，**直接用，不必再读**
- output_file（结果文件路径）；仅当预览被截断（\`truncated="true"\`）或你要全文时，用 \`get_subagent_output(agent_id)\` 读

**\`sync: true\` 仅在以下场景使用（极少）：**
- subagent 输出需要在同 turn 立即被读取后再决策
- 强一致性串行依赖：A 必须完成且输出决定 B 是否要派

**禁止的反模式：**
- ❌ 用 \`get_subagent_output\` 轮询进度（等通知，不要主动查）
- ❌ 用 \`list_active_subagents\` 反复轮询状态（只在用户问进度时才调）`

const BUILTIN_WORKER_SUBAGENT_GUIDANCE = `## 子 Agent 委派

调 \`delegate_task\` 默认异步：工具立即返回 \`{agent_id, status:"launched"}\`；可用时还会带 \`child_trace_id\`。

子 Agent 完成或失败后，系统会在后续 turn 注入 \`<sub_agent_notification>…</sub_agent_notification>\`，其中包含子 Agent 名称、状态和最终结果或错误。收到通知后，基于结果继续当前 Worker 的任务。

只有必须在同一 turn 取得结果后才能继续决策时，才使用 \`sync: true\`；此时结果直接在 \`delegate_task\` 返回值中。

不要调用未提供的子 Agent 查询或管理工具。`
