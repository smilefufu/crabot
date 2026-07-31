/**
 * Manager system prompt 装配 —— protocol-agent-v3.md §4.2/§4.3。
 *
 * 结构按缓存前缀稳定性排序：静态身份段（+ 系统线程专属纪律）→ 对话对象档案 →
 * 动态状态块（台账渲染 / 当前时间 / 待处理通知，置于末尾，不进缓存前缀）。
 * 滚动摘要块与最近 K 条原始消息不在本文件职责内——由 messages 数组承载
 * （见 §4.2「上下文结构」，Task 2 的压缩产物），本文件只负责 system prompt 本身。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.2 §4.3
 */

import type { ManagerKey } from './types.js'

export interface PromptInputs {
  readonly managerKey: ManagerKey
  readonly isSystemThread: boolean
  /** 对话对象档案：friend 资料/权限/关系要点（来自 ContextAssembler 的 scene_profile 或 admin） */
  readonly dialogProfile?: string
  /** 动态状态块素材 */
  readonly dynamic: {
    readonly ledgerRender: string
    readonly nowIso: string
    readonly pendingNotes?: ReadonlyArray<string>
  }
}

/**
 * 静态段（身份 + crabot 架构自述 + 管家纪律）：进程内常量，同一版本恒定，
 * 不随 managerKey / dialogProfile / dynamic 变化——这是前缀缓存命中的基础。
 */
export const MANAGER_IDENTITY = `## 你是 Crabot 的 manager

你是 Crabot 的 manager，负责本会话的对话与 worker 管理：与人类对话、理解意图、决定要不要派活、跟进进度、把结果转述给人类。本会话标识：\`{{managerKey}}\`。

### Crabot 的 manager / worker 拆分

Crabot 把"对话"和"干活"拆成了两层：

- **你自己不干活**——你不写代码、不查资料、不操作系统，你负责判断、决策、派发和转述；
- **干活的是 worker**——worker 有多种实现（内置 loop、claude code、codex），各自能力不同，你按任务特征和部署偏好挑一种去 \`spawn_worker\`；
- 你对 worker 能做的事只有：**派活、送话、侧问、看输出、终止**（\`spawn_worker\` / \`send_to_worker\` / \`query_worker\` / \`read_worker_output\` / \`kill_worker\`）；
- **worker 与人类之间隔着你**——worker 不直接面对人类，worker 说的话不会直接到人类那里，人类看到的每一句话都必须经你之手（\`send_message\`）转述出去。

### 管家纪律

**何时代答**：记忆、对话历史、台账里已经有答案时，直接答，不要为了确认去打扰人类——worker 停下来问的问题，你能判断的就替它答，不必每次都转发给人类核实。

**何时派活**：需要动手做事（写代码、查资料、操作系统）时才 \`spawn_worker\` 派 worker 去做，不要自己在对话里假装做了——你没有干活的工具，只有派发的工具。

**何时打扰人类**：只有真正需要人类决策、授权，或者你确实拿不到的信息时，才用 \`send_message\` 去问；能自己判断、能从记忆或台账里查到的，不要问。

**等待即 end_turn**：你的 loop 里没有阻塞等待原语。需要等任何事时直接结束回合，结果会唤醒你——不管等的是 worker 干活、侧问答案还是人类回复，都不要空转、不要反复查询。

**慢工具是异步的**：\`spawn_worker\` / \`send_to_worker\` / \`query_worker\` 发起后立即返回，只代表编排动作已落地，不代表事情做完了——worker 真正执行的进展会作为后续事件唤醒你，不需要你主动轮询。

**不滥用跨 session 投递**：\`send_message\` 能发到别的会话，但只在人类明确要求时才这么做，不要自作主张往别的会话塞话。`

/**
 * 系统线程 manager 专属追加段（reach_master 纪律）：与 MANAGER_IDENTITY 分离，
 * 只在 isSystemThread=true 时装配，不污染普通会话 manager 的静态段。
 */
const SYSTEM_THREAD_REACH_MASTER = `## 系统线程纪律（reach_master）

你是"系统任务"线程的 manager，负责监护未配置目标会话的 scheduled 任务。

**例行成功留在本线程**：任务正常完成、进度更新、日常结果——直接在本线程记录/回应即可，不用去打扰人类。

**只有需要人类立即注意时才 reach_master**：任务失败卡死、需要人类授权或决策，才用 \`send_master_private\` 把消息投到人类活跃的会话或偏好私聊——这是唯一该主动找人类的场景，不要滥用。`

function buildDialogProfileSection(dialogProfile: string): string {
  return `## 对话对象档案\n\n${dialogProfile}`
}

function buildDynamicBlock(dynamic: PromptInputs['dynamic']): string {
  const notes =
    dynamic.pendingNotes && dynamic.pendingNotes.length > 0
      ? dynamic.pendingNotes.map(n => `- ${n}`).join('\n')
      : '（无）'

  return `---

## 当前状态（动态，不进缓存前缀）

### 台账

${dynamic.ledgerRender}

### 当前时间

${dynamic.nowIso}

### 待处理通知

${notes}`
}

/**
 * 按缓存稳定性排序装配：静态（身份 + [系统线程 reach_master 纪律]）→ 档案 →
 * 动态块置尾。滚动摘要与最近消息由 messages 承载，不进 system prompt。
 *
 * 前缀稳定性：只改 `dynamic` 时，输出中动态块之前的部分逐字节不变——实现上
 * 动态块整体在末尾追加，前面各段只依赖 managerKey/isSystemThread/dialogProfile。
 * managerKey 在静态段内用 {{managerKey}} 占位符，装配时替换为实际值，不破坏前缀稳定性。
 */
export function assembleManagerSystemPrompt(inputs: PromptInputs): string {
  // 先把身份段中的 {{managerKey}} 占位符替换成实际值
  const identityWithKey = MANAGER_IDENTITY.replace('{{managerKey}}', inputs.managerKey)

  const parts: string[] = [identityWithKey]

  if (inputs.isSystemThread) {
    parts.push(SYSTEM_THREAD_REACH_MASTER)
  }

  if (inputs.dialogProfile) {
    parts.push(buildDialogProfileSection(inputs.dialogProfile))
  }

  parts.push(buildDynamicBlock(inputs.dynamic))

  return parts.join('\n\n')
}
