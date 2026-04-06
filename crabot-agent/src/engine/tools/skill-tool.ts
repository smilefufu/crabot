import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'

const SKILLS_REL_PATH = '.claude/skills'

async function listSkillIds(skillsDir: string): Promise<ReadonlyArray<string>> {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

async function readSkillContent(skillsDir: string, skillId: string): Promise<string | null> {
  try {
    const filePath = join(skillsDir, skillId, 'SKILL.md')
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function createSkillTool(baseDir: string): ToolDefinition {
  const skillsDir = join(baseDir, SKILLS_REL_PATH)

  return defineTool({
    name: 'Skill',
    description: 'Load a skill (prompt template) to guide your work. Use "list" to see available skills.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name/ID to load, or "list" to see available skills.',
        },
      },
      required: ['skill'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input) => {
      const skillInput = (input.skill as string).trim()

      const ids = await listSkillIds(skillsDir)

      if (skillInput === 'list' || skillInput === '') {
        if (ids.length === 0) {
          return { output: 'No skills available.', isError: false }
        }
        return {
          output: `Available skills:\n${ids.map((id) => `- ${id}`).join('\n')}`,
          isError: false,
        }
      }

      const content = await readSkillContent(skillsDir, skillInput)
      if (content !== null) {
        const skillDir = join(skillsDir, skillInput)
        let baseDir = skillDir
        try {
          const markerContent = await readFile(join(skillDir, '.skill_dir'), 'utf-8')
          baseDir = markerContent.trim()
        } catch {
          // No marker file, use local directory
        }
        return { output: `Base directory for this skill: ${baseDir}\n\n${content}`, isError: false }
      }

      const availableHint = ids.length > 0
        ? `\nAvailable skills: ${ids.join(', ')}`
        : ''
      return {
        output: `Skill not found: ${skillInput}${availableHint}`,
        isError: true,
      }
    },
  })
}
