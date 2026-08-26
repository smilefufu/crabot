import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createSkillTool } from '../../../src/engine/tools/skill-tool'
import type { SkillConfig } from '../../../src/types.js'

describe('createSkillTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'skill-tool-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function writeSkill(name: string, content: string): string {
    const skillDir = join(tempDir, name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')
    return skillDir
  }

  function writeSkillWithResources(
    name: string,
    content: string,
    resources: Record<string, string>,
  ): string {
    const skillDir = writeSkill(name, content)
    for (const [relPath, fileContent] of Object.entries(resources)) {
      const fullPath = join(skillDir, relPath)
      mkdirSync(join(fullPath, '..'), { recursive: true })
      writeFileSync(fullPath, fileContent, 'utf-8')
    }
    return skillDir
  }

  function makeSkillConfig(name: string, skillDir: string): SkillConfig {
    return { id: name, name, description: '', skill_dir: skillDir }
  }

  it('returns correct ToolDefinition metadata', () => {
    const skillDir = writeSkill('any', '# any')
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('any', skillDir)] })

    expect(tool.name).toBe('Skill')
    expect(tool.description).toContain('MUST')
    expect(tool.description).toContain('available_skills')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.permissionLevel).toBe('safe')
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        skill: { type: 'string', description: expect.any(String) },
      },
      required: ['skill'],
    })
  })

  it('loads a skill by name with <skill_content> wrapping', async () => {
    const dir = writeSkill('code-review', '---\nname: code-review\ndescription: Review code\n---\n# Code Review\nReview the code carefully.')
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('code-review', dir)] })

    const result = await tool.call({ skill: 'code-review' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('<skill_content name="code-review">')
    expect(result.output).toContain('# Code Review')
    expect(result.output).toContain('Review the code carefully.')
    expect(result.output).toContain('</skill_content>')
  })

  it('strips YAML frontmatter from output', async () => {
    const dir = writeSkill('my-skill', '---\nname: my-skill\ndescription: A skill\n---\n# Body Content')
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('my-skill', dir)] })

    const result = await tool.call({ skill: 'my-skill' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('name: my-skill')
    expect(result.output).not.toContain('description: A skill')
    expect(result.output).toContain('# Body Content')
  })

  it('handles content without frontmatter', async () => {
    const dir = writeSkill('plain', '# Plain Skill\nNo frontmatter here.')
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('plain', dir)] })

    const result = await tool.call({ skill: 'plain' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('# Plain Skill')
    expect(result.output).toContain('No frontmatter here.')
  })

  it('enumerates bundled resources in <skill_resources>', async () => {
    const dir = writeSkillWithResources(
      'with-resources',
      '---\nname: with-resources\ndescription: Has resources\n---\n# Skill',
      {
        'references/guide.md': '# Guide',
        'scripts/run.py': 'print("hello")',
      },
    )
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('with-resources', dir)] })

    const result = await tool.call({ skill: 'with-resources' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('<skill_resources>')
    expect(result.output).toContain('<file>references/guide.md</file>')
    expect(result.output).toContain('<file>scripts/run.py</file>')
    expect(result.output).toContain('</skill_resources>')
  })

  it('skips hidden resources without stopping sibling resource enumeration', async () => {
    const dir = writeSkillWithResources(
      'hidden-resource',
      '# Skill',
      {
        '.DS_Store': 'ignored',
        'references/guide.md': '# Guide',
        'scripts/run.py': 'print("hello")',
      },
    )
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('hidden-resource', dir)] })

    const result = await tool.call({ skill: 'hidden-resource' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('.DS_Store')
    expect(result.output).toContain('<file>references/guide.md</file>')
    expect(result.output).toContain('<file>scripts/run.py</file>')
  })

  it('omits <skill_resources> when no resources exist', async () => {
    const dir = writeSkill('no-resources', '---\nname: no-resources\ndescription: test\n---\n# Skill')
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('no-resources', dir)] })

    const result = await tool.call({ skill: 'no-resources' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('<skill_resources>')
  })

  it('includes skill directory path (admin 端 skill_dir 绝对路径直传)', async () => {
    const dir = writeSkill('my-skill', '# Skill')
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('my-skill', dir)] })

    const result = await tool.call({ skill: 'my-skill' }, {})

    expect(result.isError).toBe(false)
    // 直接报 admin 传来的绝对路径，不再有 .skill_dir marker 间接层
    expect(result.output).toContain(`Skill directory: ${dir}`)
  })

  it('lists available skills sorted alphabetically', async () => {
    const dir1 = writeSkill('code-review', '# Code Review')
    const dir2 = writeSkill('testing', '# Testing Guide')
    const tool = createSkillTool({
      availableSkills: [
        makeSkillConfig('testing', dir2),
        makeSkillConfig('code-review', dir1),
      ],
    })

    const result = await tool.call({ skill: 'list' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('code-review')
    expect(result.output).toContain('testing')
    // 排序：code-review < testing
    const codeIdx = result.output.indexOf('code-review')
    const testIdx = result.output.indexOf('testing')
    expect(codeIdx).toBeLessThan(testIdx)
  })

  it('returns error for non-existent skill', async () => {
    const dir = writeSkill('code-review', '# Code Review')
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('code-review', dir)] })

    const result = await tool.call({ skill: 'nonexistent' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('nonexistent')
    expect(result.output).toContain('code-review')
  })

  it('matches skill name case-insensitively', async () => {
    const dir = writeSkill('daily-reflection', '# Reflection')
    const tool = createSkillTool({ availableSkills: [makeSkillConfig('daily-reflection', dir)] })

    const result = await tool.call({ skill: 'Daily-Reflection' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('<skill_content name="daily-reflection">')
  })

  it('handles empty skills list', async () => {
    const tool = createSkillTool({ availableSkills: [] })

    const result = await tool.call({ skill: 'list' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('No skills available')
  })

  it('returns read-error when SKILL.md missing under skill_dir', async () => {
    // 故意指向不存在的路径，模拟 admin 给的引用脏了
    const tool = createSkillTool({
      availableSkills: [makeSkillConfig('ghost', join(tempDir, 'does-not-exist'))],
    })

    const result = await tool.call({ skill: 'ghost' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Failed to read skill: ghost')
  })
})
