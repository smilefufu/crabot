import { readdir, readFile } from 'fs/promises'
import { join, relative } from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'

const SKILLS_REL_PATH = '.claude/skills'

async function listSkillNames(skillsDir: string): Promise<ReadonlyArray<string>> {
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

const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/

function stripFrontmatter(content: string): string {
  const match = content.match(FRONTMATTER_RE)
  return match ? match[1] : content
}

const SKILL_MD_FILES = new Set(['SKILL.md', 'skill.md'])

async function enumerateResources(skillDir: string): Promise<ReadonlyArray<string>> {
  const resources: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (!SKILL_MD_FILES.has(entry.name)) {
        resources.push(relative(skillDir, fullPath))
      }
    }
  }
  await walk(skillDir)
  return resources.sort()
}

export function createSkillTool(baseDir: string): ToolDefinition {
  const skillsDir = join(baseDir, SKILLS_REL_PATH)

  return defineTool({
    name: 'Skill',
    category: 'mcp_skill',
    description:
      'Activate a skill to load specialized instructions for a specific task. ' +
      'When a task matches a skill\'s description in <available_skills>, you MUST call this tool ' +
      'with the skill name BEFORE doing any work on that task. ' +
      'Use "list" to see available skills.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name to activate, or "list" to see available skills.',
        },
      },
      required: ['skill'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input) => {
      const skillInput = (input.skill as string).trim()

      const names = await listSkillNames(skillsDir)

      if (skillInput === 'list' || skillInput === '') {
        if (names.length === 0) {
          return { output: 'No skills available.', isError: false }
        }
        return {
          output: `Available skills:\n${names.map((name) => `- ${name}`).join('\n')}`,
          isError: false,
        }
      }

      const lowerInput = skillInput.toLowerCase()
      const matchedName = names.find((n) => n.toLowerCase() === lowerInput)

      if (!matchedName) {
        const availableHint = names.length > 0
          ? `\nAvailable skills: ${names.join(', ')}`
          : ''
        return {
          output: `Skill not found: ${skillInput}${availableHint}`,
          isError: true,
        }
      }

      const skillDir = join(skillsDir, matchedName)
      const filePath = join(skillDir, 'SKILL.md')

      let content: string
      try {
        content = await readFile(filePath, 'utf-8')
      } catch {
        return { output: `Failed to read skill: ${matchedName}`, isError: true }
      }

      // Resolve real skill directory (may point to original source via .skill_dir marker)
      let resolvedDir = skillDir
      try {
        const markerContent = await readFile(join(skillDir, '.skill_dir'), 'utf-8')
        resolvedDir = markerContent.trim()
      } catch {
        // No marker file, use local directory
      }

      // Strip frontmatter — body only per Agent Skills standard
      const body = stripFrontmatter(content)

      // Enumerate bundled resources
      const resources = await enumerateResources(resolvedDir)
      const resourcesXml = resources.length > 0
        ? `\n<skill_resources>\n${resources.map((r) => `  <file>${r}</file>`).join('\n')}\n</skill_resources>`
        : ''

      const output =
        `<skill_content name="${matchedName}">\n` +
        `${body}\n\n` +
        `Skill directory: ${resolvedDir}\n` +
        `Relative paths in this skill are relative to the skill directory.` +
        `${resourcesXml}\n` +
        `</skill_content>`

      return { output, isError: false }
    },
  })
}
