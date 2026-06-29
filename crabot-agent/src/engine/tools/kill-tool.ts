/**
 * Kill tool — terminate a background entity.
 *
 * Plan 2 Tasks 7–9: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md
 */

import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import type { BgToolDeps } from './output-tool'
import { killShellTree } from '../bg-entities/bg-shell.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function killShell(
  entityId: string,
  deps: BgToolDeps,
): Promise<{ output: string; isError: boolean }> {
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

  // Cross-platform: POSIX sends SIGTERM (+ SIGKILL after 3s) to the process
  // group; Windows runs `taskkill /F /T /PID` to forcefully terminate the
  // whole child tree in one call.
  killShellTree(record.pgid)

  await deps.registry.update(entityId, {
    status: 'killed',
    exit_code: -1,
    ended_at: new Date().toISOString(),
  })

  const msg = process.platform === 'win32'
    ? `taskkill /F /T issued for persistent shell ${entityId}`
    : `Sent SIGTERM to persistent shell ${entityId} (SIGKILL fallback in 3s)`
  return { output: msg, isError: false }
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

  const controller = deps.agentAbortControllers?.get(entityId)
  if (controller) {
    controller.abort()
  }

  await deps.registry.update(entityId, {
    status: 'killed',
    ended_at: new Date().toISOString(),
  })
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
