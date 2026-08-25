import { defineTool } from '../tool-framework'
import { localHostToolExecutor } from '../local-host-tool-executor'
import type { ToolDefinition } from '../types'
import type { SkillConfig } from '../../types.js'

export interface SkillToolOptions {
  readonly availableSkills: ReadonlyArray<SkillConfig>
  readonly getCwd?: () => string
}

export function createSkillTool(options: SkillToolOptions): ToolDefinition {
  const skills = options.availableSkills.map((skill) => ({ name: skill.name, skill_dir: skill.skill_dir }))
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
      properties: { skill: { type: 'string', description: 'Skill name to activate, or "list" to see available skills.' } },
      required: ['skill'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    async call(input, context) {
      return (await localHostToolExecutor.execute('skill', {
        skill: input.skill,
        available_skills: skills,
      }, options.getCwd?.() ?? process.cwd(), context)).result
    },
  })
}
