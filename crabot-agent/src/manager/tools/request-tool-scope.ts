import type { ToolDefinition, ToolCallContext, ToolCallResult, PermissionDecision } from '../../engine/types.js'
import type { RequestRunContext } from '../conversation-request-runner.js'
import type { RequestPermissionSource } from '../request-permission-sources.js'
import type { RequestOperationFrame } from '../conversation-request-authority.js'
import type { RequestExecutionCapabilities, ExecutionCapabilities } from './execution-capabilities.js'
import type { ToolFaceDeps } from './tool-face.js'
import { buildManagerToolFace } from './tool-face.js'
import { boundedRequestPermissions } from '../../workers/harness/request-permissions.js'
import { allowed, denied, checkFileAccess } from '../../permissions/tool-authorization.js'

/** Existing group query/label fallback; scopes do not create a new Memory visibility boundary. */
export function requestMemoryScopes(source: RequestPermissionSource, sessionId: string): string[] {
  return source.kind === 'group' && source.resolved.memory_scopes.length === 0 ? [sessionId] : [...source.resolved.memory_scopes]
}

export interface RequestToolScopeDeps {
  context: RequestRunContext
  raw(source: RequestPermissionSource, recheck?: () => Promise<RequestPermissionSource>, operation?: { name: string; input: Record<string, unknown> }): ToolFaceDeps
  /** Completes semantic checks which an entry-category check cannot express. */
  checkOperation(name: string, input: Record<string, unknown>, source: RequestPermissionSource): Promise<PermissionDecision>
}

/** Candidate definitions never carry executable union permissions. */
export class RequestManagerToolScope {
  constructor(private readonly deps: RequestToolScopeDeps) {}

  private raw(name: string, source: RequestPermissionSource, recheck?: () => Promise<RequestPermissionSource>, input?: Record<string, unknown>): ToolDefinition | undefined {
    const faceState: NonNullable<ToolFaceDeps['faceState']> = { mode: 'progressive', loadedNames: new Set() }
    buildManagerToolFace({ ...this.deps.raw(source, recheck, input ? { name, input } : undefined), faceState, decorateTool: undefined })
    return faceState.catalog!.project({ ...faceState, mode: 'full' }, faceState.searchTool).find(tool => tool.name === name)
  }
  private async check(name: string, input: Record<string, unknown>, source: RequestPermissionSource): Promise<PermissionDecision> {
    const { request } = this.deps.context
    if (request.delivery.kind === 'requester_private' && name === 'send_private_message' && input.friend_id !== request.delivery.requester_friend_id) return denied('PERMISSION_DENIED', '请求投递目标固定')
    const tool = this.raw(name, source)
    if (!tool?.authorization || !tool.authorization.available()) return denied('CAPABILITY_UNAVAILABLE', '当前来源不提供该工具')
    const entry = await tool.authorization.check(input)
    if (!entry.allowed) return entry
    if (name === 'inspect_project_docs' && typeof input.project_root === 'string') {
      const file = await checkFileAccess(source.resolved, input.project_root, process.cwd(), false)
      if (!file.allowed) return file
    }
    return this.deps.checkOperation(name, input, source)
  }
  private async bounded(frame: RequestOperationFrame): Promise<RequestPermissionSource> {
    const permissions = await boundedRequestPermissions(frame.ceiling, frame.current)
    const before = requestMemoryScopes(frame.ceiling, frame.source.message.session.session_id), now = requestMemoryScopes(frame.current, frame.source.message.session.session_id)
    permissions.memory_scopes = before.length === 0 ? now : now.length === 0 ? before : before.filter(scope => now.includes(scope))
    return { ...frame.current, is_master: frame.ceiling.is_master && frame.current.is_master, resolved: permissions }
  }
  private reason(error: unknown): string {
    const message = error instanceof Error ? error.message : ''
    return message.startsWith('CAPABILITY_UNKNOWN') ? 'CAPABILITY_UNKNOWN' : message.includes('closed') ? 'REQUEST_CLOSED' : 'PERMISSION_DENIED'
  }
  private async capabilityPlans(name: string, args: Record<string, unknown>, callContext: ToolCallContext): Promise<ToolCallResult> {
    const request_sources: RequestExecutionCapabilities['request_sources'] = []
    for (const kind of ['group', 'friend'] as const) {
      const ceiling = this.deps.context.request.permission_sources[kind]
      if (!ceiling) continue
      try {
        request_sources.push(await this.deps.context.authority.run(source => source.kind === kind ? this.check(name, args, source) : Promise.resolve(denied('PERMISSION_DENIED', '来源不符')), async frame => {
          const source = await this.bounded(frame), tool = this.raw(name, source)!
          const result = await tool.call(args, callContext)
          if (result.isError) throw new Error('CAPABILITY_UNKNOWN')
          return { kind, subject_id: source.subject_id, is_master: source.is_master, status: 'available' as const, capabilities: JSON.parse(result.output) as ExecutionCapabilities }
        }))
      } catch { request_sources.push({ kind, subject_id: ceiling.subject_id, status: 'unavailable' }) }
    }
    return { output: JSON.stringify({ schema_version: 1, request_id: this.deps.context.request.request_id, request_sources }), isError: false }
  }
  decorate = (definition: ToolDefinition): ToolDefinition => {
    const authorize = async (input: Record<string, unknown>): Promise<PermissionDecision> => {
      try {
        await this.deps.context.authority.run(source => this.check(definition.name, structuredClone(input), source), async () => undefined)
        return allowed
      } catch (error) { return denied(this.reason(error), '原请求或当前完整授权不允许此操作') }
    }
    // The approved fixed-delivery prompt replaces the old group-only report_to clause.
    const description = definition.name === 'resolve_worker_turn' && this.deps.context.request.delivery.kind === 'requester_private'
      ? definition.description.replace('reported 或 asked_human 必须已向该执行器的 report_to 成功发送；', '') : definition.description
    return { ...definition, description,
      authorization: { role: 'manager', entry: definition.authorization?.entry ?? 'role', available: () => true, check: authorize },
      call: async (input, callContext) => {
        const args = structuredClone(input)
        let invoked = false
        try {
          if (definition.name === 'get_execution_capabilities' && args.worker_id === undefined) return this.capabilityPlans(definition.name, args, callContext)
          return await this.deps.context.authority.run(source => this.check(definition.name, args, source), async frame => {
            const recheck = () => this.deps.context.authority.run(source => source.kind === frame.current.kind
              ? this.check(definition.name, args, source) : Promise.resolve(denied('PERMISSION_DENIED', '不能在操作中切换来源')), selected => this.bounded(selected))
            const source = await recheck()
            const tool = this.raw(definition.name, source, recheck, args)
            if (!tool) return { output: 'CAPABILITY_UNAVAILABLE', isError: true }
            invoked = true
            const result = await tool.call(args, callContext)
            if (!result.isError && (['send_message', 'send_private_message'].includes(definition.name) || definition.name.startsWith('mcp__crab-memory__'))) {
              try {
                const body = JSON.parse(result.output)
                if (body && typeof body === 'object' && (body.error !== undefined || body.error_code !== undefined)) return { ...result, isError: true }
              } catch { /* Ordinary non-JSON delivery output retains its declared result. */ }
            }
            if (result.isError && definition.name === 'resolve_worker_turn' && this.deps.context.request.delivery.kind === 'requester_private' && result.output.includes('report_to')) return { ...result, output: 'DELIVERY_UNCONFIRMED' }
            return result
          })
        } catch (error) {
          return { output: invoked ? 'TOOL_EXECUTION_OUTCOME_UNKNOWN' : this.reason(error), isError: true }
        }
      },
    }
  }
}
