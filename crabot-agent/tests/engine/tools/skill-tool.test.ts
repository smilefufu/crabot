import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createSkillTool } from '../../../src/engine/tools/skill-tool'

describe('createSkillTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'skill-tool-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function writeSkill(name: string, content: string): void {
    const skillDir = join(tempDir, '.claude', 'skills', name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')
  }

  function writeSkillWithResources(
    name: string,
    content: string,
    resources: Record<string, string>,
  ): void {
    const skillDir = join(tempDir, '.claude', 'skills', name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')
    for (const [relPath, fileContent] of Object.entries(resources)) {
      const fullPath = join(skillDir, relPath)
      mkdirSync(join(fullPath, '..'), { recursive: true })
      writeFileSync(fullPath, fileContent, 'utf-8')
    }
  }

  it('returns correct ToolDefinition metadata', () => {
    const tool = createSkillTool(tempDir)

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
    writeSkill('code-review', '---\nname: code-review\ndescription: Review code\n---\n# Code Review\nReview the code carefully.')
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'code-review' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('<skill_content name="code-review">')
    expect(result.output).toContain('# Code Review')
    expect(result.output).toContain('Review the code carefully.')
    expect(result.output).toContain('</skill_content>')
  })

  it('strips YAML frontmatter from output', async () => {
    writeSkill('my-skill', '---\nname: my-skill\ndescription: A skill\n---\n# Body Content')
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'my-skill' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('name: my-skill')
    expect(result.output).not.toContain('description: A skill')
    expect(result.output).toContain('# Body Content')
  })

  it('handles content without frontmatter', async () => {
    writeSkill('plain', '# Plain Skill\nNo frontmatter here.')
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'plain' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('# Plain Skill')
    expect(result.output).toContain('No frontmatter here.')
  })

  it('enumerates bundled resources in <skill_resources>', async () => {
    writeSkillWithResources(
      'with-resources',
      '---\nname: with-resources\ndescription: Has resources\n---\n# Skill',
      {
        'references/guide.md': '# Guide',
        'scripts/run.py': 'print("hello")',
      },
    )
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'with-resources' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('<skill_resources>')
    expect(result.output).toContain('<file>references/guide.md</file>')
    expect(result.output).toContain('<file>scripts/run.py</file>')
    expect(result.output).toContain('</skill_resources>')
  })

  it('omits <skill_resources> when no resources exist', async () => {
    writeSkill('no-resources', '---\nname: no-resources\ndescription: test\n---\n# Skill')
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'no-resources' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('<skill_resources>')
  })

  it('includes skill directory path', async () => {
    writeSkill('my-skill', '# Skill')
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'my-skill' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Skill directory:')
  })

  it('resolves .skill_dir marker for real skill directory', async () => {
    const realDir = '/original/skill/path'
    const skillDir = join(tempDir, '.claude', 'skills', 'marker-test')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# Skill', 'utf-8')
    writeFileSync(join(skillDir, '.skill_dir'), realDir, 'utf-8')

    const tool = createSkillTool(tempDir)
    const result = await tool.call({ skill: 'marker-test' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain(`Skill directory: ${realDir}`)
  })

  it('lists available skills', async () => {
    writeSkill('code-review', '# Code Review')
    writeSkill('testing', '# Testing Guide')
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'list' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('code-review')
    expect(result.output).toContain('testing')
  })

  it('returns error for non-existent skill', async () => {
    writeSkill('code-review', '# Code Review')
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'nonexistent' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('nonexistent')
    expect(result.output).toContain('code-review')
  })

  it('matches skill name case-insensitively', async () => {
    writeSkill('daily-reflection', '# Reflection')
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'Daily-Reflection' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('<skill_content name="daily-reflection">')
  })

  it('handles empty skills directory', async () => {
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'list' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('No skills available')
  })
})
