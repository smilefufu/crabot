import { describe, it, expect } from 'vitest'
import { PromptManager } from '../src/prompt-manager.js'

const pm = new PromptManager()

const frontPrivate = pm.assembleFrontPrompt({ isGroup: false })
const frontGroup = pm.assembleFrontPrompt({ isGroup: true })
const worker = pm.assembleWorkerPrompt()

describe('Front prompt — 三段式章节标题', () => {
  it('私聊版含三段标题', () => {
    expect(frontPrivate).toContain('## 一、判别')
    expect(frontPrivate).toContain('## 二、决策')
    expect(frontPrivate).toContain('## 三、收尾措辞')
  })

  it('群聊版含三段标题', () => {
    expect(frontGroup).toContain('## 一、判别')
    expect(frontGroup).toContain('## 二、决策')
    expect(frontGroup).toContain('## 三、收尾措辞')
  })
})

describe('Front prompt — 已搬移规则保留', () => {
  it('决策判断标准保留', () => {
    expect(frontPrivate).toContain('1-2 步工具调用内完成')
    expect(frontPrivate).toContain('需要多步操作')
    expect(frontPrivate).toContain('任务匹配某个 skill')
  })

  it('伪终态规则保留', () => {
    expect(frontPrivate).toContain('"让我..."')
    expect(frontPrivate).toContain('"我来..."')
    expect(frontPrivate).toContain('"稍等"')
  })

  it('supplement_task 使用条件保留', () => {
    expect(frontPrivate).toContain('supplement_task')
    expect(frontPrivate).toContain('活跃任务列表中存在匹配')
  })

  it('已注入的上下文段保留', () => {
    expect(frontPrivate).toContain('最近消息')
    expect(frontPrivate).toContain('短期记忆')
    expect(frontPrivate).toContain('活跃任务')
  })

  it('记忆路由保留', () => {
    expect(frontPrivate).toContain('store_memory')
    expect(frontPrivate).toContain('set_scene_anchor')
  })

  it('user_attitude 4 档判定保留', () => {
    expect(frontPrivate).toContain('strong_pass')
    expect(frontPrivate).toContain('strong_fail')
    expect(frontPrivate).toContain('情绪用于判别')
  })

  it('user_attitude 绝不填情形保留', () => {
    expect(frontPrivate).toContain('感觉')
    expect(frontPrivate).toContain('全新话题')
    expect(frontPrivate).toContain('补充（不是纠偏）')
  })

  it('群聊规则保留（仅群聊版）', () => {
    expect(frontGroup).toContain('## 群聊规则')
    expect(frontGroup).toContain('被 @你 时禁止 stay_silent')
    expect(frontPrivate).not.toContain('## 群聊规则')
  })

  it('私聊版包含必须回复声明', () => {
    expect(frontPrivate).toContain('必须回复')
  })
})

describe('Front prompt — 新增规则', () => {
  it('收到失败反馈时（决策段）', () => {
    expect(frontPrivate).toContain('收到失败反馈时')
    expect(frontPrivate).toContain('要我现在就去修吗')
    expect(frontPrivate).toContain('禁止')
  })

  it('reply.text 克制反问（收尾段）', () => {
    expect(frontPrivate).toContain('克制反问')
    expect(frontPrivate).toContain('信息不足以决策')
    expect(frontPrivate).toContain('用户态度模糊')
    expect(frontPrivate).toContain('多分支')
    expect(frontPrivate).toContain('破坏性操作')
    expect(frontPrivate).toContain('最多一个')
  })

  it('ack_text 禁止反问（收尾段）', () => {
    expect(frontPrivate).toContain('ack_text')
    expect(frontPrivate).toContain('立即开始')
  })
})

describe('Worker prompt — 三段式章节标题', () => {
  it('含三段标题', () => {
    expect(worker).toContain('## 一、接任')
    expect(worker).toContain('## 二、执行')
    expect(worker).toContain('## 三、收尾')
  })
})

describe('Worker prompt — 已搬移规则保留', () => {
  it('工作目录段保留', () => {
    expect(worker).toContain('/tmp/crabot-task-{task_id}/')
    expect(worker).toContain('不要修改 Crabot 自身的代码目录')
  })

  it('Skill 加载强制要求保留', () => {
    expect(worker).toContain('调用 Skill')
    expect(worker).toContain('强制要求')
  })

  it('记忆存储 set_scene_anchor 保留', () => {
    expect(worker).toContain('set_scene_anchor')
    expect(worker).toContain('身份类稳定信息')
  })

  it('记忆存储 store_memory + type 字段对齐 v2', () => {
    expect(worker).toContain('store_memory')
    expect(worker).toContain('fact')
    expect(worker).toContain('lesson')
    expect(worker).toContain('concept')
  })

  it('记忆存储黑名单保留', () => {
    expect(worker).toContain('一次性数据快照')
    expect(worker).toContain('时效性新闻')
  })

  it('importance 字段说明保留', () => {
    expect(worker).toContain('importance')
    expect(worker).toContain('日常偏好 3-5')
  })
})

describe('Worker prompt — 新增规则', () => {
  it('能力盲区元认知（接任段）', () => {
    expect(worker).toContain('能力盲区')
    expect(worker).toContain('crabot mcp add')
    expect(worker).toContain('ask_human')
    expect(worker).toContain('PERMISSION_DENIED')
  })

  it('Execution Bias（执行段）', () => {
    expect(worker).toContain('Execution Bias')
    expect(worker).toContain('mutable facts')
    expect(worker).toContain('live check')
  })

  it('完成判定 Evidence or Named Blocker（收尾段）', () => {
    expect(worker).toContain('Evidence')
    expect(worker).toContain('named blocker')
    expect(worker).toContain('已完成')
    expect(worker).toContain('已验证')
  })

  it('分层声明覆盖（收尾段）', () => {
    expect(worker).toContain('已验')
    expect(worker).toContain('未验')
  })

  it('收尾的克制反问（收尾段）', () => {
    expect(worker).toContain('信息不足以决策')
    expect(worker).toContain('最多一个')
  })

  it('隐藏内部 ID（报告输出规范）', () => {
    expect(worker).toContain('隐藏内部 ID')
    expect(worker).toContain('message_id')
    expect(worker).toContain('task_id')
    expect(worker).toContain('对用户是噪音')
    expect(worker).toContain('不论 master、其他人或群聊')
  })

  it('不要绕过用户的硬约束（specification gaming）', () => {
    expect(worker).toContain('specification gaming')
    expect(worker).toContain('designer intent')
    expect(worker).toContain('硬约束')
    expect(worker).toContain('一、接任段的三条路径')
  })
})

describe('Front prompt — 删除项不应再出现', () => {
  it('不含 ProgressDigest 已接管的过时叙事', () => {
    expect(frontPrivate).not.toContain('实时看到')
  })
})

describe('Worker prompt — 删除项不应再出现', () => {
  it('不含 L0/L1/L2 v1 残留', () => {
    expect(worker).not.toContain('L0')
    expect(worker).not.toContain('L1')
    expect(worker).not.toContain('L2')
    expect(worker).not.toContain('概览')
  })

  it('不含 "执行过程中你输出的文字用户都能实时看到"', () => {
    expect(worker).not.toContain('实时看到')
  })

  it('不含原 6 步执行流程的"如需用户确认或反馈调用 ask_human"', () => {
    expect(worker).not.toContain('如需用户确认或反馈')
  })
})

describe('PromptManager 注入', () => {
  it('worker capabilities 注入', () => {
    const out = pm.assembleFrontPrompt({
      isGroup: false,
      workerCapabilities: [{ category: '浏览器操作', tools: ['screenshot'] }],
    })
    expect(out).toContain('任务执行能力范围')
    expect(out).toContain('浏览器操作')
    expect(out).toContain('工具调用硬性规则')
  })

  it('skill listing 注入', () => {
    const out = pm.assembleFrontPrompt({
      isGroup: false,
      skillListing: '## 可用技能\n- foo: bar',
    })
    expect(out).toContain('可用技能')
    expect(out).toContain('foo: bar')
  })
})

describe('PromptManager.assembleWorkerPrompt — opts 签名', () => {
  it('opts.skillListing 注入到 system prompt', () => {
    const out = pm.assembleWorkerPrompt({
      adminPersonality: 'You are X.',
      skillListing: '<available_skills>\n<skill><name>foo</name><description>bar</description></skill>\n</available_skills>',
    })
    expect(out).toContain('You are X.')
    expect(out).toContain('<available_skills>')
    expect(out).toContain('<name>foo</name>')
  })

  it('opts.skillListing 不传则不含具体 skill 条目', () => {
    // WORKER_RULES 的"Skill 加载"段落会提到 <available_skills> 占位符；
    // 真正的注入会在其后跟一个 <skill> 子条目。这里断言"没有具体的 skill 条目被注入"。
    const out = pm.assembleWorkerPrompt({
      adminPersonality: 'You are X.',
    })
    expect(out).not.toContain('<skill>')
  })

  it('opts.adminPersonality 不再夹带 skill listing（独立通道）', () => {
    const out = pm.assembleWorkerPrompt({
      adminPersonality: 'pure personality, no skills here',
      skillListing: '<available_skills>\n<skill><name>x</name><description>y</description></skill>\n</available_skills>',
    })
    const personalityIdx = out.indexOf('pure personality')
    const skillIdx = out.indexOf('<available_skills>')
    expect(personalityIdx).toBeGreaterThanOrEqual(0)
    expect(skillIdx).toBeGreaterThanOrEqual(0)
    expect(personalityIdx).not.toBe(skillIdx)
  })

  it('opts.availableSubAgents 仍正常注入', () => {
    const out = pm.assembleWorkerPrompt({
      availableSubAgents: [{ toolName: 'visual_analyzer', workerHint: '分析图片' }],
    })
    expect(out).toContain('专项 Sub-agent')
    expect(out).toContain('visual_analyzer')
  })
})

describe('Crabot 产品自我认知 — Front + Worker 同源注入', () => {
  it('Front 私聊版含产品自我认知段', () => {
    expect(frontPrivate).toContain('## 你是 Crabot')
    expect(frontPrivate).toContain('完整运营基础设施')
  })

  it('Front 群聊版同样含产品自我认知段', () => {
    expect(frontGroup).toContain('## 你是 Crabot')
    expect(frontGroup).toContain('完整运营基础设施')
  })

  it('Worker 含产品自我认知段', () => {
    expect(worker).toContain('## 你是 Crabot')
    expect(worker).toContain('完整运营基础设施')
  })

  it('明确"主动型 AI 员工"产品定位（不是仅响应式问答机器人）', () => {
    expect(frontPrivate).toContain('主动型 AI 员工')
    expect(worker).toContain('主动型 AI 员工')
    // 主动 = 自发推动事情（产品定位的核心动词）
    expect(frontPrivate).toContain('自发推动事情')
  })

  it('涵盖 Crabot 全部基础设施类别（不是只 schedule + task + memory 三件套）', () => {
    // 这条测试把"涵盖度"固化下来——以后想精简，必须显式把项目从这里删掉，
    // 提醒维护者"自我认知文案的目的就是描绘整个能力空间"。
    for (const infra of [
      '多 Channel',
      '任务系统',
      '调度系统',
      '记忆系统',
      '权限系统',
      '工具生态',
      '自管理 CLI',
    ]) {
      expect(frontPrivate).toContain(infra)
      expect(worker).toContain(infra)
    }
  })

  it('主动性的 4 类具体动作都有提及（每条对应当前可执行的载体）', () => {
    // 时间主动 / 任务内主动反应 / 收尾主动多想一步 / 自我维护
    // 用动作动词而非触发词，避免 specification gaming
    expect(frontPrivate).toContain('crabot schedule add')        // 时间主动
    expect(frontPrivate).toContain('send_private_message')       // 任务内主动反应
    expect(frontPrivate).toContain('多想一步')                    // 收尾主动
    expect(frontPrivate).toContain('daily-reflection')           // 自我维护
    expect(frontPrivate).toContain('memory-curate')
    expect(frontPrivate).toContain('quick_reflection')
  })

  it('"任务收尾时多想一步" 显式守 specification gaming 边界', () => {
    expect(frontPrivate).toContain('多想一步')
    expect(frontPrivate).toContain('specification gaming')
    expect(frontPrivate).toContain('别擅自扩张到未授权的事')
  })

  it('用"承诺 → 产物"目标语义引导，不依赖触发词清单', () => {
    expect(frontPrivate).toContain('承诺 → 产物')
    expect(frontPrivate).toContain('可观测、可重放的产物')
    expect(worker).toContain('承诺 → 产物')
  })

  it('显式点出"我会想着 / 盯着 / 主动观察"是没有产物的反模式', () => {
    expect(frontPrivate).toContain('我会想着')
    expect(worker).toContain('我会想着')
  })

  it('对话对象是"人类"而非 master（Crabot 是多 Channel / 多 Friend 角色）', () => {
    // CRABOT_PRODUCT_SELF 段不应出现"对 master 的承诺"——多 Friend 场景下不准确
    expect(frontPrivate).toContain('对人类的承诺')
    expect(worker).toContain('对人类的承诺')
  })
})

describe('Worker prompt — 主动性诉求的物化段', () => {
  it('收尾段含"主动性诉求的物化"小节（按当前 schedule 机制描述，不预告未来）', () => {
    expect(worker).toContain('### 主动性诉求的物化')
    expect(worker).toContain('系统也能按预期触发')
  })

  it('给出三条物化路径', () => {
    expect(worker).toContain('项目自治')
    expect(worker).toContain('系统级调度')
    expect(worker).toContain('crabot schedule add')
    expect(worker).toContain('信息留痕')
  })

  it('调度参数提示完整（cron / once / 必填 priority / 目标会话）', () => {
    expect(worker).toContain('--cron')
    expect(worker).toContain('--trigger-at')
    // priority 是 admin 协议必填字段，CLI 要求显式传
    expect(worker).toContain('--priority')
    // 提醒类调度通过 task_template.input 把目标 channel/session 透传给 worker
    expect(worker).toContain('--target-channel')
    expect(worker).toContain('--target-session')
  })

  it('不再使用旧"持续性"框架命名（避免把主动性窄化成持续性）', () => {
    expect(worker).not.toContain('### 持续性需求的物化')
  })
})

describe('Front 工具调用硬性规则 — 措辞精准（修复 A→B 间发现的 over-restriction）', () => {
  it('不再写死"你唯一能调用的工具是 4 个决策工具"', () => {
    const out = pm.assembleFrontPrompt({
      isGroup: false,
      workerCapabilities: [{ category: 'browser', tools: [] }],
    })
    // 旧措辞会让 LLM 误以为 query_tasks / create_schedule / messaging MCP 等
    // 已注册工具都不能调用——本次放宽为"已注册给你的工具列表"。
    expect(out).not.toContain('你唯一能调用的工具是你的决策工具')
    expect(out).toContain('已注册给你的工具列表')
  })

  it('保留反幻觉防护：禁止模拟 Worker 端工具', () => {
    const out = pm.assembleFrontPrompt({
      isGroup: false,
      workerCapabilities: [{ category: 'browser', tools: [] }],
    })
    expect(out).toContain('Worker 端能力')
    expect(out).toContain('<invoke name="...">')
    expect(out).toContain('必须通过 create_task 委派')
  })
})
