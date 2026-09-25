import { defineTool, type ToolDefinition } from '../../engine/index.js'
import type { ResolvedPermissions } from '../../types.js'
import type { WorkerImplId } from '../../workers/types.js'
import type { ToolFaceDeps } from './tool-face.js'
import { BUILTIN_WORKER_PERMISSIONS, narrowWorkerPermissions, workerCliExecutionPermissions } from '../../workers/builtin/runtime.js'

export interface ExecutionToolObservation {
  readonly observed_at: string
  readonly tools: readonly string[]
  readonly source: 'current_builtin_assembly' | 'next_cli_provision'
  readonly mcp_servers: readonly string[]
  readonly limitations: readonly string[]
}
export type DescribeExecutionTools = (impl: WorkerImplId, principal?: ResolvedPermissions) => ExecutionToolObservation

export function createExecutionCapabilitiesTool(deps: ToolFaceDeps): ToolDefinition {
  return defineTool({
    name: 'get_execution_capabilities',
    description: '仅在没有有效能力事实、能力或权限已变化，或要复用的执行器需要核对固定权限时查询一次。省略参数查询三种实现的新建条件；worker_id 查询当前会话已有执行器的固定权限。旧执行器不会随联系人改权而自动更新；工具未接入与权限拒绝分开判断。查询不执行任务、不授予权限；控制面返回的拒绝就是当前事实，不要用重复查询代替处置。',
    inputSchema: { type: 'object', properties: {
      worker_id: { type: 'string' }, impl: { type: 'string', enum: ['builtin', 'claude-code', 'codex'] },
    }, additionalProperties: false },
    isReadOnly: true,
    async call(input) {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['worker_id', 'impl'].includes(key))) throw new Error('仅接受 worker_id 或 impl')
        const args = input as { worker_id?: string; impl?: WorkerImplId }
        if (args.worker_id !== undefined && (typeof args.worker_id !== 'string' || !args.worker_id.trim())) throw new Error('worker_id 必须是非空字符串')
        if (args.impl !== undefined && !['builtin', 'claude-code', 'codex'].includes(args.impl)) throw new Error('未知执行实现')
        if (args.worker_id && args.impl) throw new Error('已有执行器的实现由台账决定，不同时接受 impl')
        const current = deps.workerContext()
        let principal = current.principalPermissions
        let implementations: WorkerImplId[] = args.impl ? [args.impl] : ['builtin', 'claude-code', 'codex']
        let workspace: string | undefined
        if (args.worker_id) {
          const found = await deps.projectDocs.ledger.findWorker(args.worker_id)
          if (!found || found.managerKey !== current.managerKey) throw new Error('执行器不存在或不属于当前会话')
          const incarnation = found.worker.incarnations.filter(item => item.forked_from === undefined).at(-1)
          if (!incarnation || incarnation.impl === 'legacy') throw new Error('该执行器没有可核实的现代执行化身')
          implementations = [incarnation.impl]
          workspace = incarnation.workspace
          principal = (await deps.projectDocs.readWorkerContext(args.worker_id))?.principal_permissions
        }
        const registry = deps.workerImplSnapshot?.()
        return { isError: false, output: JSON.stringify({
          can_spawn: current.principalPermissions?.tool_access.task ?? null,
          permission_source: args.worker_id ? 'persisted_worker_principal' : 'current_delegation_principal',
          principal_known: principal !== undefined,
          ...(args.worker_id ? { worker_id: args.worker_id, workspace } : {}),
          implementations: implementations.map(impl => ({
            impl,
            ready: registry?.statuses.find(item => item.impl === impl)?.ready ?? null,
            permissions: narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, principal ?? null),
            cli_access: workerCliExecutionPermissions(principal).cli_access,
            ...(deps.describeExecutionTools?.(impl, principal) ?? {
              tools: null, mcp_servers: null, limitations: ['工具装配信息当前不可核实。'],
            }),
            ...(args.worker_id && impl !== 'builtin' ? { current_incarnation_tools: 'unknown',
              current_incarnation_note: '所列 MCP 为当前配置下下次 provision 的条件，不代表运行中 CLI 的连接或原生工具状态。' } : {}),
          })),
        }) }
      } catch (error) { return { isError: true, output: `执行条件查询失败：${(error as Error).message}` } }
    },
  })
}
