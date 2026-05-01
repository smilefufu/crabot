/**
 * Output tool — read incremental output from a background entity.
 *
 * Plan 2 Tasks 7–9: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md
 */

import fs from 'node:fs/promises'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import type { BgEntityRegistry } from '../bg-entities/registry'
import type { TransientShellRegistry } from '../bg-entities/bg-shell'
import { BG_OUTPUT_MAX_BYTES } from '../bg-entities/types'

export interface BgToolDeps {
  readonly registry: BgEntityRegistry
  readonly transient: TransientShellRegistry
  readonly cursorMap: Map<string, number>
  readonly taskId: string
  readonly ownerFriendId?: string
  /** Sub-agent abortControllers map (key=entity_id); used to abort a running bg agent on Kill */
  readonly agentAbortControllers?: Map<string, AbortController>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cursorKey(taskId: string, entityId: string): string {
  return `${taskId}:${entityId}`
}

async function readShellOutput(
  entityId: string,
  explicitOffset: number | undefined,
  deps: BgToolDeps,
): Promise<{ output: string; isError: boolean }> {
  // 1. Check transient first (in-memory ring buffer, no offset concept)
  const transientState = deps.transient.get(entityId)
  if (transientState) {
    const header = `[status: ${transientState.status}, exit_code: ${transientState.exit_code ?? 'null'}]`
    const output = `${header}\n${transientState.ringBuffer}`
    return { output, isError: false }
  }

  // 2. Check persistent registry (disk log file with per-task cursor)
  const record = await deps.registry.get(entityId)
  if (!record) {
    return { output: `Entity not found: ${entityId}`, isError: true }
  }

  if (record.type !== 'shell') {
    return { output: `Entity ${entityId} is not a shell entity`, isError: true }
  }

  const key = cursorKey(deps.taskId, entityId)
  const currentOffset = explicitOffset ?? deps.cursorMap.get(key) ?? 0

  let fileStats: { size: number }
  try {
    fileStats = await fs.stat(record.log_file)
  } catch {
    return { output: `Log file not accessible for ${entityId}`, isError: true }
  }

  const fileSize = fileStats.size
  if (fileSize <= currentOffset) {
    const header = `[status: ${record.status}, exit_code: ${record.exit_code ?? 'null'}]`
    return { output: `${header}\n(no new output)`, isError: false }
  }

  const bytesToRead = Math.min(BG_OUTPUT_MAX_BYTES, fileSize - currentOffset)
  const remaining = fileSize - currentOffset - bytesToRead

  let chunk: Buffer
  const fh = await fs.open(record.log_file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytesToRead)
    const { bytesRead } = await fh.read(buf, 0, bytesToRead, currentOffset)
    chunk = buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }

  const newOffset = currentOffset + chunk.length
  deps.cursorMap.set(key, newOffset)

  // Update last_activity_at on the registry record
  await deps.registry.update(entityId, { last_activity_at: new Date().toISOString() })

  const header = `[status: ${record.status}, exit_code: ${record.exit_code ?? 'null'}]`
  let output = `${header}\n${chunk.toString('utf8')}`

  if (remaining > 0) {
    output += `\n[truncated, more available with from_offset=${newOffset}]`
  }

  return { output, isError: false }
}

async function readLastJsonlLines(file: string, n: number): Promise<string> {
  try {
    const text = await fs.readFile(file, 'utf-8')
    const lines = text.split('\n').filter((l) => l.trim())
    return lines.slice(-n).join('\n')
  } catch {
    return '(no activity log)'
  }
}

async function readAgentOutput(
  id: string,
  _explicitOffset: number | undefined,
  deps: BgToolDeps,
): Promise<{ output: string; isError: boolean }> {
  const record = await deps.registry.get(id)
  if (!record) {
    return { output: `Entity not found: ${id}`, isError: true }
  }
  if (record.type !== 'agent') {
    return { output: `Mismatched entity type for ${id}: expected agent, got ${record.type}`, isError: true }
  }

  if (record.status === 'completed' && record.result_file) {
    try {
      const content = await fs.readFile(record.result_file, 'utf-8')
      await deps.registry.update(id, { last_activity_at: new Date().toISOString() })
      return {
        output: `[status: completed, exit_code: ${record.exit_code}]\n${content}`,
        isError: false,
      }
    } catch (err) {
      return { output: `[status: completed but result_file read failed: ${err}]`, isError: true }
    }
  }

  if (record.status === 'failed' || record.status === 'killed') {
    const recent = await readLastJsonlLines(record.messages_log_file, 5)
    return {
      output: `[status: ${record.status}, exit_code: ${record.exit_code}]\n${recent}`,
      isError: false,
    }
  }

  if (record.status === 'stalled') {
    const recent = await readLastJsonlLines(record.messages_log_file, 5)
    return {
      output: `[status: stalled, ended_at: ${record.ended_at}]\n${recent}`,
      isError: false,
    }
  }

  // running → return last 10 lines of messages_log
  const recent = await readLastJsonlLines(record.messages_log_file, 10)
  await deps.registry.update(id, { last_activity_at: new Date().toISOString() })
  return {
    output: `[status: running, in progress; recent activity:]\n${recent}`,
    isError: false,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOutputTool(deps: BgToolDeps): ToolDefinition {
  return defineTool({
    name: 'Output',
    category: 'shell',
    description:
      'Read incremental output from a background entity (shell or sub-agent). ' +
      'Default returns content since last Output call from this task.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'shell_xxx or agent_xxx',
        },
        from_offset: {
          type: 'integer',
          description: 'Optional: explicit byte offset; default uses per-task cursor',
        },
      },
      required: ['entity_id'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input) => {
      const entityId = input.entity_id as string
      const explicitOffset = input.from_offset as number | undefined

      if (entityId.startsWith('shell_')) {
        return readShellOutput(entityId, explicitOffset, deps)
      }

      if (entityId.startsWith('agent_')) {
        return readAgentOutput(entityId, explicitOffset, deps)
      }

      return {
        output: `Invalid entity_id format: ${entityId}`,
        isError: true,
      }
    },
  })
}
