import { defineTool, type ToolDefinition } from '../../engine/index.js'
import type { ResolvedPermissions, CliAccessConfig, StoragePermission } from '../../types.js'
import type { WorkerImplId } from '../../workers/types.js'
import type { ToolFaceDeps } from './tool-face.js'
import { effectiveToolAccess, TOOL_ENTRY_EXPLANATIONS, type EffectiveToolAccessConfig, type EffectiveToolCategory, type ExecutionObservation } from 'crabot-shared'
import { executionAdmission } from '../../workers/execution-policy.js'
import { executionObservation } from '../../permissions/execution-observation.js'

export type DescribeExecutionTools = (impl: WorkerImplId, principal?: ResolvedPermissions) => ExecutionObservation
export interface ExecutionImplementation {
  impl: WorkerImplId
  ready: boolean | null
  admission: { status: 'allowed' | 'blocked' | 'conditional' | 'unknown'; reasons: string[] }
  observation: ExecutionObservation
}
export interface ExecutionCapabilities {
  schema_version: 1
  orchestration: { can_spawn: boolean; scope: 'current_manager'; reasons: string[] }
  authorization: {
    known: boolean
    source: 'current_principal' | 'worker_snapshot' | 'missing'
    tool_access: EffectiveToolAccessConfig | null
    cli_access: CliAccessConfig | null
    storage: StoragePermission | null
    memory_scopes: string[] | null
    explanations: Record<EffectiveToolCategory, string>
    memory_enforcement: 'unverified'
  }
  role_capabilities: { role: 'manager'; child_profiles: string[] }
  execution: { implementations: ExecutionImplementation[] }
}

export function createExecutionCapabilitiesTool(deps: ToolFaceDeps): ToolDefinition {
  return defineTool({
    name: 'get_execution_capabilities',
    description: '核对主体授权、角色职责和执行事实。省略参数返回当前主体的新建计划；worker_id 返回当前会话 Worker 的固定主体和最新主线化身记录，impl 仅筛选新建计划。planned 不代表实际收到工具；legacy_unknown 不代表权限被关闭。工具调用明确拒绝前，不将缺记录或角色限制当成需要用户开权。查询不派发、不授予权限。',
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
        let recorded: ExecutionObservation | undefined
        if (args.worker_id) {
          const found = await deps.projectDocs.ledger.findWorker(args.worker_id)
          if (!found || found.managerKey !== current.managerKey) throw new Error('执行器不存在或不属于当前会话')
          const incarnation = found.worker.incarnations.filter(item => item.forked_from === undefined).at(-1)
          if (!incarnation || incarnation.impl === 'legacy') throw new Error('该执行器没有现代主线化身')
          implementations = [incarnation.impl]
          principal = (await deps.projectDocs.readWorkerContext(args.worker_id))?.principal_permissions
          recorded = incarnation.incarnation_id && deps.readExecutionObservation
            ? await deps.readExecutionObservation(args.worker_id, incarnation.incarnation_id, incarnation.impl)
            : executionObservation({ role: 'worker', impl: incarnation.impl, state: 'legacy_unknown', source: 'legacy',
                worker_id: args.worker_id, incarnation_id: incarnation.incarnation_id, constraints: ['该化身没有可核实记录；不从当前配置补推。'] })
        }
        const registry = deps.workerImplSnapshot?.()
        const entries = implementations.map(impl => ({ impl,
          ready: registry?.statuses.find(item => item.impl === impl)?.ready ?? null,
          admission: executionAdmission(impl, principal),
          observation: recorded ?? deps.describeExecutionTools?.(impl, principal)
            ?? executionObservation({ role: 'worker', impl, source: 'execution_plan', constraints: ['当前装配计划不可核实。'] }),
        }))
        const result: ExecutionCapabilities = {
          schema_version: 1,
          orchestration: { can_spawn: !!current.principalPermissions, scope: 'current_manager',
            reasons: current.principalPermissions ? [] : ['CAPABILITY_UNKNOWN: 新建执行器需要可信主体授权'] },
          authorization: { known: !!principal, source: principal ? args.worker_id ? 'worker_snapshot' : 'current_principal' : 'missing',
            tool_access: principal ? effectiveToolAccess(principal.tool_access) : null,
            cli_access: principal?.cli_access ?? null, storage: principal?.storage ?? null,
            memory_scopes: principal?.memory_scopes ?? null, explanations: TOOL_ENTRY_EXPLANATIONS, memory_enforcement: 'unverified' },
          role_capabilities: { role: 'manager', child_profiles: [...new Set(entries.flatMap(entry => entry.observation.child_profiles))] },
          execution: { implementations: entries },
        }
        return { isError: false, output: JSON.stringify(result) }
      } catch (error) { return { isError: true, output: `执行条件查询失败：${(error as Error).message}` } }
    },
  })
}
