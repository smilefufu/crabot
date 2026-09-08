import { existsSync } from 'node:fs'
import path from 'node:path'
import { defineTool, type ToolDefinition } from '../engine/index.js'
import type { MCPServerConfig } from '../types.js'
import type { WorkerWorkspaceGitContext } from './types.js'
import { WorkspaceGitInspector } from './harness/workspace-git-inspector.js'
import { writeSensitiveFileAtomic } from './provision/materialize.js'

export const WORKSPACE_GIT_MCP_SERVER_NAME = 'crabot-workspace-git'
export const WORKSPACE_GIT_CONTEXT_ENV = 'CRABOT_WORKSPACE_GIT_CONTEXT_FILE'

export async function workspaceGitBridgeEnv(runtimeDir: string, seq: number, binding?: WorkerWorkspaceGitContext): Promise<Record<string, string>> {
  if (!binding) return { [WORKSPACE_GIT_CONTEXT_ENV]: '' }
  const contextFile = path.join(runtimeDir, `workspace-git-${seq}.json`)
  // Keep large baselines in the existing private adapter directory, separate for each incarnation.
  await writeSensitiveFileAtomic(contextFile, JSON.stringify(binding))
  return { [WORKSPACE_GIT_CONTEXT_ENV]: contextFile }
}

export function createWorkspaceGitTool(binding: WorkerWorkspaceGitContext): ToolDefinition {
  const fixed: WorkerWorkspaceGitContext = JSON.parse(JSON.stringify(binding))
  const inspector = new WorkspaceGitInspector()
  return defineTool({
    name: 'inspect_workspace_git',
    category: 'file_io',
    description: '只读刷新当前工作区 Git 状态，并与本化身启动基线比较；提交列表属于整个仓库，不表示任务归属或完成。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    isReadOnly: true,
    async call(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0) {
        return { isError: true, output: 'inspect_workspace_git 不接受参数' }
      }
      const git = await inspector.inspect(fixed.workspace_root, fixed.baseline)
      return { output: JSON.stringify({ worker_id: fixed.worker_id, incarnation_id: fixed.incarnation_id, git }), isError: false }
    },
  })
}

export function createWorkspaceGitMcpServerConfig(): MCPServerConfig {
  const compiled = path.join(__dirname, '..', 'mcp', 'workspace-git-stdio-server.js')
  let args: string[]
  if (existsSync(compiled)) args = [compiled]
  else {
    const source = path.join(__dirname, '..', 'mcp', 'workspace-git-stdio-server.ts')
    if (!existsSync(source)) throw new Error('workspace Git stdio bridge entry is unavailable')
    const project = path.resolve(__dirname, '..', '..', 'tsconfig.json')
    args = ['-e', `require(${JSON.stringify(require.resolve('ts-node'))}).register({transpileOnly:true,experimentalResolver:true,project:${JSON.stringify(project)}});require(${JSON.stringify(source)}).startWorkspaceGitStdioServer().catch(()=>{console.error('workspace Git bridge startup failed');process.exitCode=1})`]
  }
  return { name: WORKSPACE_GIT_MCP_SERVER_NAME, transport: 'stdio', command: process.execPath, args }
}
