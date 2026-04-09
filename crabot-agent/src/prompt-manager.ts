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

// ── 私聊/群聊共用部分 ──
const FRONT_RULES_SHARED = `## 纠偏判断指南

当用户消息可能是对活跃任务的纠偏时：
- 检查活跃任务列表，优先匹配同 session 发起的任务
- 如果匹配到任务且语义明确 -> supplement_task（指定 task_id）
- 如果没有活跃任务或消息明显是新请求 -> create_task

## 判断标准

- 能在 1-2 步工具调用内完成 -> direct_reply
- 需要多步骤或复杂推理 -> create_task
- 不确定时 -> create_task

## create_task 字段指引

- task_title：任务标题，简明扼要
- task_description：一句话分类标注，描述任务方向。不要概括用户的完整需求——用户的原始消息会完整传递给任务执行环节
- task_type：general / code / analysis / command

## 记忆存储

当用户要求记住/记录某些信息时：
1. 调用 store_memory 工具写入长期记忆（提供 content 和 tags）
2. 然后调用 make_decision(direct_reply) 确认已记住

tags 应涵盖关键维度，如人物、主题、类型（身份属性、偏好习惯、项目知识、重要事件等）。

这属于"1-2 步工具调用内完成"的场景，使用 direct_reply。

## 记忆查询

当用户询问"你还记得...吗"或需要回忆之前记住的信息时：
1. 调用 search_memory 工具搜索相关记忆
2. 如需查看详情，调用 get_memory_detail 工具
3. 然后调用 make_decision(direct_reply) 回答`

// ── 私聊 Front Rules ──
// 私聊中没有 silent 选项，从根本上杜绝误判
const FRONT_RULES_PRIVATE = `## 决策输出

你必须调用 make_decision 工具输出决策。三种类型：

1. direct_reply — 直接回复（简单问答、问候、任务状态查询）
2. create_task — 创建新任务（复杂操作、代码编写、数据分析）
3. supplement_task — 补充/纠偏已有任务（用户对正在执行的任务有新指示）

这是私聊场景，用户在直接和你对话，你必须回复。

${FRONT_RULES_SHARED}`

// ── 群聊 Front Rules ──
// 群聊中增加 silent 选项和群聊专属规则
const FRONT_RULES_GROUP = `## 决策输出

你必须调用 make_decision 工具输出决策。四种类型：

1. direct_reply — 直接回复（简单问答、问候、任务状态查询）
2. create_task — 创建新任务（复杂操作、代码编写、数据分析）
3. supplement_task — 补充/纠偏已有任务（用户对正在执行的任务有新指示）
4. silent — 静默（与自己无关的消息）

## 群聊规则（严格执行）

在群聊中，你是旁听者，不是对话参与者。默认 silent。

只有同时满足以下条件时才回复：
1. 消息明确指向你（以下任一）：
   - 消息标注了 [@你]
   - 有人叫你的昵称
   - 上下文中只有你一个可能的对话对象（群里只有发送者和你）
2. 且消息内容确实需要你行动（提问、指令、求助）

**被 @你 时禁止 silent**：只要消息标注了 [@你]，你必须回复（direct_reply 或 create_task），绝不能选 silent。

以下情况必须 silent：
- 群成员之间互相讨论（即使话题是代码/技术/你擅长的领域）
- 群成员之间一问一答（有明确的对话双方，你不是其中之一）
- 系统通知、加群消息、分享链接等非对话内容
- 不确定是否在叫你时，选择 silent

${FRONT_RULES_SHARED}`

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
- 如果上方标注了"已发送的即时回复"，说明你已经向用户确认过了，不要再说类似的话，直接开始工作
- 如果有 Front Agent 已完成的工作（"## Front Agent 已完成的工作"段落），请直接使用那些信息
- 执行过程中你输出的文字用户都能实时看到。只输出有价值的阶段性成果，不要输出中间思考（如"让我试试..."、"现在尝试..."）
- 一次完整的结果总结就够了。如果你在过程中已经输出了总结，最后不要再重复

## 记忆存储

你有写入长期记忆的能力（store_memory 工具）。以下情况应主动写入：

1. 用户明确要求记住 -> 必须写入
2. 发现用户偏好/习惯（如"我们用 pnpm"、"代码风格用 4 空格缩进"）
3. 了解到人物身份/背景信息（如"张三是后端负责人"）
4. 解决了有价值的问题（尤其是踩坑、调试经验）
5. 发现可复用的规律或流程
6. 获知重要项目/组织信息

写入原则：
- content 应完整清晰，包含足够上下文，不要只存用户原话
- tags 应涵盖关键维度（如人物、主题、类型），建议包含以下类型标签：
  身份属性、偏好习惯、项目知识、重要事件、问题方案、规律流程
- importance：日常偏好 3-5，重要决策 6-8，关键信息 9-10
- 不确定是否值得记住时，宁可记下（Memory 模块会自动去重合并）

## 记忆查询

当你需要回忆之前的信息（如用户偏好、项目路径等）时：
- 查看上方"长期记忆"段落中的 L0 摘要列表
- 如需详情，调用 get_memory_detail 工具查看 L1 概览或 L2 全文
- 如需搜索更多记忆，调用 search_memory 工具

## 技能（Skill）

如果系统提示中列出了"可用技能"，这些是为特定任务类型提供的专业指引。
在执行相关任务前，先调用 Skill 工具（输入技能名称）加载完整指引，然后按指引操作。
使用 Skill("list") 查看所有可用技能。`

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
    this.writeFile('front-rules-private.md', RULES_HEADER + FRONT_RULES_PRIVATE)
    this.writeFile('front-rules-group.md', RULES_HEADER + FRONT_RULES_GROUP)
    this.writeFile('worker-rules.md', RULES_HEADER + WORKER_RULES_TEMPLATE)

    // 用户管理：仅首次创建
    this.writeIfNotExists('personality.md', PERSONALITY_SEED)
    this.writeIfNotExists('front-additions.md', ADDITIONS_SEED)
    this.writeIfNotExists('worker-additions.md', ADDITIONS_SEED)
  }

  /**
   * 组装 Front Handler system prompt（区分私聊/群聊）
   * @param isGroup - 是否群聊场景
   * @param adminPersonality - Admin 配置中的 system_prompt（可选，优先级高于文件）
   */
  assembleFrontPrompt(
    isGroup: boolean,
    adminPersonality?: string,
    workerCapabilities?: ReadonlyArray<{ category: string; tools: string[] }>,
  ): string {
    const parts: string[] = []

    if (adminPersonality) {
      parts.push(adminPersonality)
    }
    const filePersonality = this.readUserFile('personality.md')
    if (filePersonality) {
      parts.push(filePersonality)
    }

    if (isGroup) {
      parts.push(this.readRulesFile('front-rules-group.md', FRONT_RULES_GROUP))
    } else {
      parts.push(this.readRulesFile('front-rules-private.md', FRONT_RULES_PRIVATE))
    }

    // Inject worker capability awareness so Front can make informed triage decisions.
    // Only category + tool names — Front decides whether to create_task, not how to call tools.
    if (workerCapabilities && workerCapabilities.length > 0) {
      const sections = workerCapabilities
        .map(({ category, tools }) => `- **${category}**: ${tools.join(', ')}`)
        .join('\n')
      parts.push(
        `## 任务执行能力范围\n\n` +
        `除了上述工具外，你还能处理以下类型的请求：\n\n${sections}\n\n` +
        `以上通过 make_decision(type="create_task") 委派执行。对用户而言都是你自己的能力，不要提及"任务"、"执行智能体"等内部概念。`
      )
    }

    const additions = this.readUserFile('front-additions.md')
    if (additions) {
      parts.push(additions)
    }

    return parts.join('\n\n')
  }

  /**
   * 组装 Worker Handler system prompt
   * @param adminPersonality - Admin 配置中的 system_prompt（可选）
   * @param availableSubAgents - 可用的专项 Sub-agent 列表（可选）
   */
  assembleWorkerPrompt(
    adminPersonality?: string,
    availableSubAgents?: ReadonlyArray<{ readonly toolName: string; readonly workerHint: string }>,
  ): string {
    const parts: string[] = []

    if (adminPersonality) {
      parts.push(adminPersonality)
    }
    const filePersonality = this.readUserFile('personality.md')
    if (filePersonality) {
      parts.push(filePersonality)
    }

    parts.push(this.readRulesFile('worker-rules.md', WORKER_RULES_TEMPLATE))

    // Inject sub-agent awareness
    if (availableSubAgents && availableSubAgents.length > 0) {
      const agentList = availableSubAgents
        .map((a) => `- ${a.toolName}：${a.workerHint}`)
        .join('\n')
      parts.push(
        `## 可用的专项 Sub-agent\n\n` +
        `你可以将子任务委派给以下专项 Sub-agent，它们在独立上下文中执行，只返回最终结果：\n${agentList}\n\n` +
        `适合委派的场景：\n` +
        `1. 你的能力不足以完成某个子任务（如你没有视觉能力但需要分析图片）\n` +
        `2. 子任务的中间过程你不关心，只需要最终结果（避免污染你的上下文）`
      )
    }

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
