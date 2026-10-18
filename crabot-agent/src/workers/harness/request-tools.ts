import type { ToolDefinition, PermissionDecision } from '../../engine/types.js'
import type { ResolvedPermissions, SkillConfig } from '../../types.js'
import type { RequestPermissionSource } from '../../manager/request-permission-sources.js'
import { createSkillTool } from '../../engine/tools/skill-tool.js'
import { allowed, denied, roleAuthorization } from '../../permissions/tool-authorization.js'
import type { WorkerRequestGuard } from './request-guard.js'

interface Dependencies {
  guard: WorkerRequestGuard
  workerId: string
  ceilings: ReadonlyArray<RequestPermissionSource>
  rawTools(permissions: ResolvedPermissions, includeDelegation: boolean): ReadonlyArray<ToolDefinition>
  skills(permissions: ResolvedPermissions, childAllowedIds?: ReadonlyArray<string>): ReadonlyArray<SkillConfig>
  authorizeCommand(permissions: ResolvedPermissions, input: Record<string, unknown>): Promise<PermissionDecision>
  cwd: string
}

/** Only candidate definitions are combined; execution always selects one whole, current source. */
export class WorkerRequestToolScope {
  private readonly ceilings: ReadonlyArray<RequestPermissionSource>
  constructor(private readonly deps: Dependencies) { this.ceilings = structuredClone(deps.ceilings) }
  tools(includeDelegation = true): ToolDefinition[] {
    const byName = new Map<string, ToolDefinition>()
    for (const source of this.ceilings) for (const tool of this.deps.rawTools(source.resolved, includeDelegation)) {
      if (!byName.has(tool.name)) byName.set(tool.name, tool)
    }
    return [...byName.values()].map(tool => this.wrap(tool, includeDelegation))
  }
  get permitsChildUserSkills(): boolean { return this.ceilings.some(source => source.resolved.tool_access.mcp_skill) }
  wrapChildSkill(tool: ToolDefinition, skills: ReadonlyArray<SkillConfig>): ToolDefinition {
    return this.wrap(tool, false, skills.map(skill => skill.id), undefined, 'child')
  }
  wrapChildBound(tool: ToolDefinition, rebound: ToolDefinition): ToolDefinition {
    if (tool.name !== rebound.name) throw new Error('Child tool rebound name mismatch')
    return this.wrap(tool, false, undefined, rebound, 'child')
  }
  private rejectionReason(error: unknown): string {
    const reason = error instanceof Error ? error.message : ''
    let code = 'PERMISSION_DENIED'
    if (reason.startsWith('CAPABILITY_UNKNOWN')) code = 'CAPABILITY_UNKNOWN'
    else if (reason.includes('closed')) code = 'REQUEST_CLOSED'
    return `${code}: Worker原请求或当前完整授权不允许此操作`
  }
  private actual(name: string, source: RequestPermissionSource, includeDelegation: boolean, childIds?: ReadonlyArray<string>): ToolDefinition | undefined {
    if (name === 'Skill' && childIds) {
      const tool = createSkillTool({ availableSkills: this.deps.skills(source.resolved, childIds), getCwd: () => this.deps.cwd })
      return { ...tool, authorization: roleAuthorization('child') }
    }
    return this.deps.rawTools(source.resolved, includeDelegation).find(tool => tool.name === name)
  }
  private async check(name: string, input: Record<string, unknown>, source: RequestPermissionSource, includeDelegation: boolean, childIds?: ReadonlyArray<string>): Promise<PermissionDecision> {
    const tool = this.actual(name, source, includeDelegation, childIds)
    if (!tool?.authorization || !tool.authorization.available()) return denied('CAPABILITY_UNAVAILABLE', '请求来源或当前配置不提供该工具')
    const decision = await tool.authorization.check(input)
    if (!decision.allowed) return decision
    if (name === 'Skill') {
      const skill = typeof input.skill === 'string' ? input.skill.trim().toLowerCase() : ''
      if (skill && skill !== 'list' && !this.deps.skills(source.resolved, childIds).some(item => item.name.toLowerCase() === skill)) return denied('PERMISSION_DENIED', '该来源不允许使用指定Skill')
    }
    if (name === 'Bash') return this.deps.authorizeCommand(source.resolved, input)
    return allowed
  }
  private wrap(definition: ToolDefinition, includeDelegation: boolean, childIds?: ReadonlyArray<string>, rebound?: ToolDefinition, role: 'worker' | 'child' = 'worker'): ToolDefinition {
    const authorize = async (input: Record<string, unknown>): Promise<PermissionDecision> => {
      const args = structuredClone(input)
      try {
        await this.deps.guard.runResource(this.deps.workerId, source => this.check(definition.name, args, source, includeDelegation, childIds), async () => undefined)
        return allowed
      } catch (error) { return { allowed: false, reason: this.rejectionReason(error) } }
    }
    return { ...definition,
      authorization: { role, entry: definition.authorization?.entry ?? 'role', available: () => true, check: authorize },
      call: async (input, context) => {
        const args = structuredClone(input)
        let invoked = false
        try {
          return await this.deps.guard.runResource(this.deps.workerId, source => this.check(definition.name, args, source, includeDelegation, childIds), async frame => {
            const tool = this.actual(definition.name, frame.current, includeDelegation, childIds)
            if (!tool) return { output: 'CAPABILITY_UNAVAILABLE', isError: true }
            invoked = true
            return (rebound ?? tool).call(args, context)
          })
        } catch (error) {
          if (invoked) return { output: 'TOOL_EXECUTION_OUTCOME_UNKNOWN', isError: true }
          return { output: this.rejectionReason(error), isError: true }
        }
      },
    }
  }
}
