import * as fs from 'fs'
import * as path from 'path'

/**
 * PromptManager - 统一提示词管理
 *
 * 提示词分三层：
 * 1. personality.md — 用户编辑的人格/语气
 * 2. *-rules.md — 代码管理的行为规则（每次启动覆盖）
 * 3. *-additions.md — 用户编辑的额外指令（首次创建，不覆盖）
 *
 * 组装顺序: personality + rules + additions
 */

const FRONT_RULES_TEMPLATE = `## 决策输出

你必须调用 make_decision 工具输出决策。四种类型：

1. direct_reply — 直接回复（简单问答、问候、任务状态查询）
2. create_task — 创建新任务（复杂操作、代码编写、数据分析）
3. supplement_task — 补充/纠偏已有任务（用户对正在执行的任务有新指示）
4. silent — 静默（群聊中与自己无关的消息）

## 群聊规则（严格执行）

在群聊中，你是旁听者，不是对话参与者。默认 silent。

只有同时满足以下条件时才回复：
1. 消息明确指向你（以下任一）：
   - 消息标注了 [@你]
   - 有人叫你的昵称
   - 上下文中只有你一个可能的对话对象（群里只有发送者和你）
2. 且消息内容确实需要你行动（提问、指令、求助）

以下情况必须 silent：
- 群成员之间互相讨论（即使话题是代码/技术/你擅长的领域）
- 群成员之间一问一答（有明确的对话双方，你不是其中之一）
- 系统通知、加群消息、分享链接等非对话内容
- 不确定是否在叫你时，选择 silent

## 纠偏判断指南

当用户消息可能是对活跃任务的纠偏时：
- 检查活跃任务列表，优先匹配同 session 发起的任务
- 如果只有一个匹配任务且语义明确 -> confidence: high
- 如果有多个匹配任务或语义模糊 -> confidence: low
- 如果没有活跃任务或消息明显是新请求 -> create_task

## 判断标准

- 能在 1-2 步工具调用内完成 -> direct_reply
- 需要多步骤或复杂推理 -> create_task
- 不确定时 -> create_task（宁可派给 Worker）`

const WORKER_RULES_TEMPLATE = `## 工作目录

你的默认工作目录是临时目录（/tmp/crabot-task-{task_id}/），用于存放任务产生的临时文件。
如果任务涉及特定项目，项目路径会在下方"文件访问路径"段落中列出，请在对应路径下操作。

**重要：不要修改 Crabot 自身的代码目录，除非任务明确要求你操作 Crabot 项目本身。**

## 执行流程

1. 深度分析任务需求，理解用户真实意图
2. 制定清晰的执行计划，按步骤执行
3. 执行过程中如需向用户发送进度更新，使用 send_message 工具
4. 如需用户确认或反馈，调用 ask_human 工具
5. 遇到问题及时调整方案；无法完成时说明原因并给出建议
6. 完成后输出最终结果

## 注意事项

- 完成任务后直接输出最终结果；结果会自动回复给用户，**不需要额外调用 send_message**
- 如需在执行过程中向用户发送进度更新，可以使用 send_message
- 如果有 Front Agent 已完成的工作（"## Front Agent 已完成的工作"段落），请直接使用那些信息`

const PERSONALITY_SEED = `# 人格设定

<!-- 此文件由用户编辑，Crabot 不会覆盖。 -->
<!-- 定义 Crabot 的名字、语气、个性化行为。 -->
<!-- 如果 Admin 配置中也有 system_prompt，两者会合并（Admin 的在前）。 -->
`

const ADDITIONS_SEED = `# 自定义指令

<!-- 此文件由用户编辑，Crabot 不会覆盖。 -->
<!-- 在这里添加额外的指令，会被追加到提示词末尾。 -->
<!-- 留空则不生效。 -->
`

const RULES_HEADER = `<!-- 此文件由 Crabot 自动生成，每次启动时覆盖。 -->
<!-- 自定义指令请写入对应的 *-additions.md 文件。 -->

`

export class PromptManager {
  private promptsDir: string

  constructor(dataDir: string) {
    this.promptsDir = path.join(dataDir, 'prompts')
  }

  /**
   * 初始化提示词目录：
   * - rules 文件每次覆盖（代码管理）
   * - personality / additions 文件仅首次创建（用户管理）
   */
  init(): void {
    fs.mkdirSync(this.promptsDir, { recursive: true })

    // 代码管理：每次覆盖
    this.writeFile('front-rules.md', RULES_HEADER + FRONT_RULES_TEMPLATE)
    this.writeFile('worker-rules.md', RULES_HEADER + WORKER_RULES_TEMPLATE)

    // 用户管理：仅首次创建
    this.writeIfNotExists('personality.md', PERSONALITY_SEED)
    this.writeIfNotExists('front-additions.md', ADDITIONS_SEED)
    this.writeIfNotExists('worker-additions.md', ADDITIONS_SEED)
  }

  /**
   * 组装 Front Handler system prompt
   * @param adminPersonality - Admin 配置中的 system_prompt（可选，优先级高于文件）
   */
  assembleFrontPrompt(adminPersonality?: string): string {
    const parts: string[] = []

    if (adminPersonality) {
      parts.push(adminPersonality)
    }
    const filePersonality = this.readUserFile('personality.md')
    if (filePersonality) {
      parts.push(filePersonality)
    }

    parts.push(this.readRulesFile('front-rules.md', FRONT_RULES_TEMPLATE))

    const additions = this.readUserFile('front-additions.md')
    if (additions) {
      parts.push(additions)
    }

    return parts.join('\n\n')
  }

  /**
   * 组装 Worker Handler system prompt
   * @param adminPersonality - Admin 配置中的 system_prompt（可选）
   */
  assembleWorkerPrompt(adminPersonality?: string): string {
    const parts: string[] = []

    if (adminPersonality) {
      parts.push(adminPersonality)
    }
    const filePersonality = this.readUserFile('personality.md')
    if (filePersonality) {
      parts.push(filePersonality)
    }

    parts.push(this.readRulesFile('worker-rules.md', WORKER_RULES_TEMPLATE))

    const additions = this.readUserFile('worker-additions.md')
    if (additions) {
      parts.push(additions)
    }

    return parts.join('\n\n')
  }

  private writeFile(name: string, content: string): void {
    fs.writeFileSync(path.join(this.promptsDir, name), content, 'utf-8')
  }

  private writeIfNotExists(name: string, content: string): void {
    const filePath = path.join(this.promptsDir, name)
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8')
    }
  }

  /**
   * 读取用户编辑的文件，过滤掉纯注释行和空行。
   * 如果文件只含注释/空白/bare header，返回 undefined。
   */
  private readUserFile(name: string): string | undefined {
    const filePath = path.join(this.promptsDir, name)
    if (!fs.existsSync(filePath)) return undefined
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const lines = raw.split('\n')
      const meaningful = lines.filter(line => {
        const t = line.trim()
        if (t === '') return false
        if (t.startsWith('<!--') && t.endsWith('-->')) return false
        if (/^#+\s+.{0,15}$/.test(t)) return false // bare short headers like "# 人格设定"
        return true
      })
      return meaningful.length > 0 ? meaningful.join('\n').trim() : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 读取 rules 文件，剥掉自动生成的 header 注释。
   * 如果文件不存在则返回 fallback。
   */
  private readRulesFile(name: string, fallback: string): string {
    const filePath = path.join(this.promptsDir, name)
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8')
        // Strip leading HTML comments (the auto-generated header)
        const stripped = raw.replace(/^(<!--[\s\S]*?-->\s*)+/, '').trim()
        return stripped || fallback
      }
    } catch { /* ignore */ }
    return fallback
  }
}
