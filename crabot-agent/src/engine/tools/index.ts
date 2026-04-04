import { createBashTool } from './bash-tool'
import { createReadTool } from './read-tool'
import { createWriteTool } from './write-tool'
import { createEditTool } from './edit-tool'
import { createGlobTool } from './glob-tool'
import { createGrepTool } from './grep-tool'
import { createSkillTool } from './skill-tool'
import type { ToolDefinition } from '../types'

export interface BuiltinToolsOptions {
  readonly skillsDir?: string
}

export function getAllBuiltinTools(cwd: string, options?: BuiltinToolsOptions): ReadonlyArray<ToolDefinition> {
  const tools: ToolDefinition[] = [
    createBashTool(cwd),
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createGlobTool(cwd),
    createGrepTool(cwd),
  ]

  if (options?.skillsDir) {
    tools.push(createSkillTool(options.skillsDir))
  }

  return tools
}

export {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createSkillTool,
}
