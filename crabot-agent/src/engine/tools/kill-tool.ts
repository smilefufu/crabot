/**
 * Kill tool — terminate a background entity.
 *
 * Plan 2 Tasks 7–9: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md
 */

import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import type { BgToolDeps } from './output-tool'
import { emitInstantSpan } from '../bg-entities/trace'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function killShell(
  entityId: string,
  deps: BgToolDeps,
): Promise<{ output: string; isError: boolean }> {
  // 1. Check transient registry first
  const transientState = deps.transient.get(entityId)
  if (transientState) {
    if (transientState.status !== 'running') {
      return {
        output: `Already ${transientState.status}, no-op`,
        isError: false,
      }
    }
    const statusBefore = transientState.status
    deps.transient.kill(entityId)
    if (deps.traceContext) {
      emitInstantSpan(deps.traceContext, 'bg_entity_kill', {
        entity_id: entityId,
        status_before: statusBefore,
      })
    }
    return { output: `Sent SIGTERM to transient shell ${entityId}`, isError: false }
  }

  // 2. Check persistent registry
  const record = await deps.registry.get(entityId)
  if (!record) {
    return { output: `Entity not found: ${entityId}`, isError: true }
  }

  if (record.type !== 'shell') {
    return { output: `Entity ${entityId} is not a shell entity`, isError: true }
  }

  if (record.status !== 'running') {
    return { output: `Already ${record.status}, no-op`, isError: false }
  }

  const statusBefore = record.status

  // Send SIGTERM to process group
  try {
    process.kill(-record.pgid, 'SIGTERM')
  } catch {
    // Process may already be dead — proceed with registry update
  }

  // Immediately update registry
  await deps.registry.update(entityId, {
    status: 'killed',
    exit_code: -1,
    ended_at: new Date().toISOString(),
  })

  if (deps.traceContext) {
    emitInstantSpan(deps.traceContext, 'bg_entity_kill', {
      entity_id: entityId,
      status_before: statusBefore,
    })
  }

  // SIGKILL fallback after 3 seconds
  const pgid = record.pgid
  setTimeout(() => {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // Already dead — ignore
    }
  }, 3000).unref()

  return { output: `Sent SIGTERM to persistent shell ${entityId} (SIGKILL fallback in 3s)`, isError: false }
}

async function killAgent(
  entityId: string,
  deps: BgToolDeps,
): Promise<{ output: string; isError: boolean }> {
  const record = await deps.registry.get(entityId)
  if (!record) {
    return { output: `Entity not found: ${entityId}`, isError: true }
  }
  if (record.type !== 'agent') {
    return { output: `Mismatched type for ${entityId}: expected agent, got ${record.type}`, isError: true }
  }

  if (record.status !== 'running') {
    return { output: `Already ${record.status}, no-op`, isError: false }
  }

  const statusBefore = record.status

  const controller = deps.agentAbortControllers?.get(entityId)
  if (controller) {
    controller.abort()
  }

  await deps.registry.update(entityId, {
    status: 'killed',
    ended_at: new Date().toISOString(),
  })

  if (deps.traceContext) {
    emitInstantSpan(deps.traceContext, 'bg_entity_kill', {
      entity_id: entityId,
      status_before: statusBefore,
    })
  }
  // Note: do not remove from agentAbortControllers map — bg-agent.ts finally block will do that

  return { output: `Agent ${entityId} killed.`, isError: false }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createKillTool(deps: BgToolDeps): ToolDefinition {
  return defineTool({
    name: 'Kill',
    category: 'shell',
    description: 'Terminate a background entity (shell or sub-agent).',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'shell_xxx or agent_xxx',
        },
      },
      required: ['entity_id'],
    },
    isReadOnly: false,
    permissionLevel: 'dangerous',
    call: async (input) => {
      const entityId = input.entity_id as string

      if (entityId.startsWith('shell_')) {
        return killShell(entityId, deps)
      }

      if (entityId.startsWith('agent_')) {
        return killAgent(entityId, deps)
      }

      return {
        output: `Invalid entity_id: ${entityId}`,
        isError: true,
      }
    },
  })
}
