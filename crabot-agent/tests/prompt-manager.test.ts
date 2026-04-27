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

  it('sub-agent 注入到 Worker prompt', () => {
    const out = pm.assembleWorkerPrompt(undefined, [
      { toolName: 'visual_analyzer', workerHint: '分析图片' },
    ])
    expect(out).toContain('专项 Sub-agent')
    expect(out).toContain('visual_analyzer')
    expect(out).toContain('分析图片')
  })
})
