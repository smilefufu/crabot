import { createBashTool } from './bash-tool'
import { createReadTool } from './read-tool'
import { createWriteTool } from './write-tool'
import { createEditTool } from './edit-tool'
import { createGlobTool } from './glob-tool'
import { createGrepTool } from './grep-tool'
import type { ToolDefinition } from '../types'

export function getAllBuiltinTools(cwd: string): ReadonlyArray<ToolDefinition> {
  return [
    createBashTool(cwd),
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createGlobTool(cwd),
    createGrepTool(cwd),
  ]
}

export {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
}
