/**
 * 静态内容契约测试：daily-reflection 内置 skill 必须实现 spec §6.1 ④
 * "黑名单合规扫描"步骤。
 *
 * 此步骤是 LLM 工作流（不是 Python 后端 RPC），只能通过 SKILL.md 文本契约保证落地；
 * 删除该段会导致 spec §6.1 ④ 失语，这里加锁防回退。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SKILL_PATH = path.join(
  __dirname,
  '..',
  'builtins',
  'skills',
  'daily-reflection',
  'SKILL.md',
)

describe('daily-reflection SKILL.md — spec §6.1 ④ 黑名单合规扫描', () => {
  it('SKILL.md 文件存在', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true)
  })

  it('包含黑名单合规检查步骤（spec §6.1 ④）', () => {
    const md = fs.readFileSync(SKILL_PATH, 'utf-8')
    // 必须出现"黑名单合规检查"作为子步骤标题
    expect(md).toMatch(/黑名单合规检查/)
    // 必须明确指出对命中的条目调用 delete_memory 回收
    expect(md).toMatch(/delete_memory/)
    // 必须列出黑名单类目（一次性快照 / 时效新闻 / 中间猜测 / 偶尔一次表述等）
    expect(md).toMatch(/一次性快照/)
    expect(md).toMatch(/中间猜测|偶尔一次/)
  })
})
