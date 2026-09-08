import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('workspace-context-maintenance skill doc', () => {
  it('只按需读取职责明确的项目文档，不创建混合上下文或替 Worker 管理决策', () => {
    const doc = readFileSync(
      path.resolve(__dirname, '../builtin-skills/workspace-context-maintenance/SKILL.md'),
      'utf8',
    )

    expect(doc).toContain('读取并遵守项目根目录已有的 `AGENTS.md`')
    expect(doc).toContain('`README.md`')
    expect(doc).toContain('`ARCHITECTURE.md`')
    expect(doc).toContain('向主控说明具体缺口和证据')
    expect(doc).toContain('持续开发代码项目且规则正文缺失时，在首次业务修改前创建最小 `AGENTS.md`')
    expect(doc).toContain('只读调查、问答和一次性文件处理不初始化项目')
    expect(doc).toContain('项目禁止自动提交时遵循其约定')
    expect(doc).toContain('不能混入或清理别人的工作')
    expect(doc).toContain('inspect_workspace_git')
    expect(doc).toContain('不创建、修改、取代或迁移决策记录')
    expect(doc).not.toContain('CURRENT_CONTEXT.md')
    expect(doc).not.toContain('返回给 Manager 的工作总结')
    expect(doc).not.toContain('无需更新的原因')
    expect(doc).not.toContain('set_cwd')
  })
})
