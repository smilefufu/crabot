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

  function writeSkill(id: string, content: string): void {
    const skillDir = join(tempDir, '.claude', 'skills', id)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')
  }

  it('returns correct ToolDefinition metadata', () => {
    const tool = createSkillTool(tempDir)

    expect(tool.name).toBe('Skill')
    expect(tool.description).toContain('skill')
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

  it('loads a skill by name', async () => {
    writeSkill('code-review', '# Code Review\nReview the code carefully.')
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'code-review' }, {})

    expect(result.isError).toBe(false)
    // skill-tool 会在内容前添加 base directory 信息
    expect(result.output).toContain('Base directory for this skill:')
    expect(result.output).toContain('# Code Review\nReview the code carefully.')
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

  it('handles empty skills directory', async () => {
    const tool = createSkillTool(tempDir)

    const result = await tool.call({ skill: 'list' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('No skills available')
  })
})
