import { readFileSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getBuiltinSkills, BUILTIN_SKILL_IDS } from './builtin-skills.js'
import { SkillManager } from './mcp-skill-manager.js'

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

  it.each([false, true])('新旧注册表均向 Agent 提供已批准的初始化简介（existing=%s）', async (existing) => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'workspace-skill-registry-'))
    try {
      const entries = getBuiltinSkills()
      const current = entries.find((entry) => entry.id === BUILTIN_SKILL_IDS.workspaceContextMaintenance)!
      const other = { ...entries[0], description: 'existing unrelated description', version: 'existing-version' }
      if (existing) await fs.writeFile(path.join(directory, 'skills.json'), JSON.stringify([
        { ...current, description: '旧版只读文档简介', version: '2.0.0-crabot' }, other,
      ]))
      const manager = new SkillManager(directory)
      await manager.initialize()
      await manager.seedBuiltinSkills(entries)
      const registered = manager.get(current.id)!
      const doc = await fs.readFile(path.join(current.skill_dir, 'SKILL.md'), 'utf8')
      expect(registered.version).toBe('3.0.0-crabot')
      expect(doc).toContain(`description: ${registered.description}\n`)
      expect(manager.runtimeSemanticEntries()).toContainEqual(expect.objectContaining({
        id: current.id, description: registered.description, skill_dir: current.skill_dir,
      }))
      if (existing) expect(manager.get(other.id)).toMatchObject(other)
      const persisted = await fs.readFile(path.join(directory, 'skills.json'), 'utf8')
      const restarted = new SkillManager(directory)
      await restarted.initialize()
      await restarted.seedBuiltinSkills(entries)
      expect(restarted.get(current.id)).toEqual(registered)
      expect(await fs.readFile(path.join(directory, 'skills.json'), 'utf8')).toBe(persisted)
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
})
