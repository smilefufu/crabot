/**
 * ListEntities tool — list background entities owned by the current friend.
 *
 * Plan 2 Tasks 7–9: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md
 */

import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import type { BgEntityStatus } from '../bg-entities/types'
import type { BgToolDeps } from './output-tool'
import type { TransientShellState } from '../bg-entities/bg-shell'
import type { BgEntityRecord } from '../bg-entities/types'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ScopeFilter = 'session' | 'channel' | 'all'
type StatusFilter = 'running' | 'completed' | 'failed' | 'killed' | 'stalled' | 'all'

function resolveStatuses(statusFilter: StatusFilter): ReadonlyArray<BgEntityStatus> | undefined {
  if (statusFilter === 'all') return undefined
  return [statusFilter] as ReadonlyArray<BgEntityStatus>
}

function formatRuntime(spawnedAt: string, endedAt: string | null): string {
  const startMs = new Date(spawnedAt).getTime()
  const endMs = endedAt ? new Date(endedAt).getTime() : Date.now()
  const totalSecs = Math.max(0, Math.floor((endMs - startMs) / 1000))

  if (totalSecs < 60) return `${totalSecs}s`
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins < 60) return `${mins}m${secs}s`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  return `${hours}h${remainMins}m`
}

function formatSpawnedAt(spawnedAt: string): string {
  const d = new Date(spawnedAt)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

function truncateCommand(cmd: string, maxLen = 40): string {
  if (cmd.length <= maxLen) return cmd
  return cmd.slice(0, maxLen - 3) + '...'
}

interface RowData {
  entityId: string
  status: string
  spawnedAt: string
  runtime: string
  command: string
}

function buildTable(rows: RowData[]): string {
  if (rows.length === 0) return '(no entities matching filter)'

  const header: RowData = {
    entityId: 'ID',
    status: 'STATUS',
    spawnedAt: 'SPAWNED_AT',
    runtime: 'RUNTIME',
    command: 'COMMAND/TASK',
  }

  const colWidths = {
    entityId: Math.max(header.entityId.length, ...rows.map((r) => r.entityId.length)),
    status: Math.max(header.status.length, ...rows.map((r) => r.status.length)),
    spawnedAt: Math.max(header.spawnedAt.length, ...rows.map((r) => r.spawnedAt.length)),
    runtime: Math.max(header.runtime.length, ...rows.map((r) => r.runtime.length)),
  }

  const pad = (s: string, w: number) => s.padEnd(w)

  const headerLine =
    `TYPE   ` +
    `${pad(header.entityId, colWidths.entityId)}  ` +
    `${pad(header.status, colWidths.status)}  ` +
    `${pad(header.spawnedAt, colWidths.spawnedAt)}  ` +
    `${pad(header.runtime, colWidths.runtime)}  ` +
    `${header.command}`

  const dataLines = rows.map(
    (r) =>
      `shell  ` +
      `${pad(r.entityId, colWidths.entityId)}  ` +
      `${pad(r.status, colWidths.status)}  ` +
      `${pad(r.spawnedAt, colWidths.spawnedAt)}  ` +
      `${pad(r.runtime, colWidths.runtime)}  ` +
      `${r.command}`,
  )

  return [headerLine, ...dataLines].join('\n')
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createListEntitiesTool(deps: BgToolDeps): ToolDefinition {
  return defineTool({
    name: 'ListEntities',
    category: 'shell',
    description: 'List background entities owned by the current friend.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['session', 'channel', 'all'],
          description: 'Default "session"',
        },
        status: {
          type: 'string',
          enum: ['running', 'completed', 'failed', 'killed', 'stalled', 'all'],
          description: 'Default "running"',
        },
      },
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input) => {
      const _scope = (input.scope as ScopeFilter | undefined) ?? 'session'
      const statusFilter = (input.status as StatusFilter | undefined) ?? 'running'

      const wantedStatuses = resolveStatuses(statusFilter)

      // --- Persistent (disk-backed) entities ---
      const persistentRecords = await deps.registry.list({
        owner_friend_id: deps.ownerFriendId,
        status: wantedStatuses,
      })

      // --- Transient (in-memory) entities — only current task's shells ---
      const transientFilter: { owner_friend_id?: string; status?: ReadonlyArray<BgEntityStatus> } = {
        status: wantedStatuses,
      }
      if (deps.ownerFriendId) {
        transientFilter.owner_friend_id = deps.ownerFriendId
      }
      const transientStates = deps.transient
        .list(transientFilter)
        .filter((s) => s.spawned_by_task_id === deps.taskId)

      // --- Merge + deduplicate (transient ids won't collide with persistent ids) ---
      const persistentRows: RowData[] = persistentRecords.map((rec: BgEntityRecord) => ({
        entityId: rec.entity_id,
        status: rec.status,
        spawnedAt: formatSpawnedAt(rec.spawned_at),
        runtime: formatRuntime(rec.spawned_at, rec.ended_at),
        command:
          rec.type === 'shell'
            ? truncateCommand(rec.command)
            : truncateCommand(rec.task_description),
      }))

      const transientRows: RowData[] = transientStates.map((s: TransientShellState) => ({
        entityId: s.entity_id,
        status: s.status,
        spawnedAt: formatSpawnedAt(s.spawned_at),
        runtime: formatRuntime(s.spawned_at, s.ended_at),
        command: truncateCommand(s.command),
      }))

      // Combine and sort by spawned_at descending
      const allRows = [...persistentRows, ...transientRows].sort((a, b) =>
        b.spawnedAt.localeCompare(a.spawnedAt),
      )

      return { output: buildTable(allRows), isError: false }
    },
  })
}
