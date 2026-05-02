/**
 * spawnPersistentAgent — fire-and-forget background sub-agent runner.
 *
 * Starts a runEngine() loop in the background, appends live-progress events
 * to a JSONL log on disk, and updates the registry on completion / failure.
 * Returns the agent_id immediately (non-blocking).
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-01-long-running-agent-design.md
 * Plan: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md Task 12
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LLMAdapter } from '../llm-adapter.js'
import type { ToolDefinition } from '../types.js'
import { runEngine } from '../query-loop.js'
import { getBgEntitiesLogsDir } from '../../core/data-paths.js'
import type { BgEntityRegistry } from './registry.js'
import type { BgEntityOwner, BgAgentRegistryRecord } from './types.js'
import { emitInstantSpan, type BgEntityTraceContext } from './trace.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpawnPersistentAgentOpts {
  readonly task_description: string
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly systemPrompt: string
  readonly model: string
  readonly adapter: LLMAdapter
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  readonly registry: BgEntityRegistry
  /** Worker-maintained abort-controller map: written on spawn, deleted on finish/kill. */
  readonly abortControllers: Map<string, AbortController>
  readonly traceContext?: BgEntityTraceContext
  /**
   * Async exit hook —— sub-agent loop 自然结束 / 失败时调用（killed 由 Kill 工具发出，不走这里）。
   * 用于 worker 推 push notification。抛错只 log。
   */
  readonly onExit?: (info: {
    entity_id: string
    task_description: string
    status: 'completed' | 'failed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
    result_file: string | null
  }) => void
}

/**
 * Spawn a persistent background agent loop.
 *
 * - Registers an entry in the registry with status='running' before returning.
 * - Starts `runEngine()` in a detached async IIFE (fire-and-forget).
 * - Each LiveProgressEvent is appended as a JSON line to `<logsDir>/<id>.jsonl`.
 * - On completion, writes `<logsDir>/<id>.result.txt` and updates registry.
 * - On abort or error, updates registry to status='failed' (registry.update
 *   guards against overwriting an already-killed status).
 *
 * @returns The generated entity_id (format: `agent_<12 hex chars>`)
 */
export async function spawnPersistentAgent(opts: SpawnPersistentAgentOpts): Promise<string> {
  const entity_id = `agent_${randomBytes(6).toString('hex')}`
  const logsDir = getBgEntitiesLogsDir()
  await fs.promises.mkdir(logsDir, { recursive: true })

  const messagesLog = path.join(logsDir, `${entity_id}.jsonl`)

  const abortController = new AbortController()
  opts.abortControllers.set(entity_id, abortController)

  const now = new Date().toISOString()
  const record: BgAgentRegistryRecord = {
    entity_id,
    type: 'agent',
    status: 'running',
    task_description: opts.task_description,
    messages_log_file: messagesLog,
    result_file: null,
    owner: opts.owner,
    spawned_by_task_id: opts.spawned_by_task_id,
    spawned_at: now,
    exit_code: null,
    ended_at: null,
    last_activity_at: now,
  }
  await opts.registry.register(record)

  // Emit spawn span.
  if (opts.traceContext) {
    emitInstantSpan(opts.traceContext, 'bg_entity_spawn', {
      entity_id,
      type: 'agent',
      mode: 'persistent',
      task_description: opts.task_description,
    })
  }

  const agentSpawnedAtMs = Date.now()

  // fire-and-forget — intentionally not awaited by caller
  void (async () => {
    try {
      const result = await runEngine({
        prompt: opts.task_description,
        adapter: opts.adapter,
        options: {
          systemPrompt: opts.systemPrompt,
          tools: [...opts.tools],
          model: opts.model,
          abortSignal: abortController.signal,
          onLiveProgress: (event) => {
            // Append event as a JSONL line; errors are silently swallowed so
            // logging failures never crash the agent loop.
            void fs.promises
              .appendFile(messagesLog, JSON.stringify(event) + '\n')
              .catch(() => {})
            // Bump last_activity_at on every progress event.
            void opts.registry
              .update(entity_id, {
                last_activity_at: new Date().toISOString(),
              } as Partial<BgAgentRegistryRecord>)
              .catch(() => {})
          },
        },
      })

      // Write result file and update registry on successful completion.
      const resultFile = path.join(logsDir, `${entity_id}.result.txt`)
      await fs.promises.writeFile(resultFile, result.finalText ?? '', 'utf-8')

      const endedStatus =
        result.outcome === 'completed' ? ('completed' as const) : ('failed' as const)
      const exitCode = result.outcome === 'completed' ? 0 : 1
      const runtimeMs = Date.now() - agentSpawnedAtMs
      if (opts.traceContext) {
        emitInstantSpan(opts.traceContext, 'bg_entity_exit', {
          entity_id,
          type: 'agent',
          status: endedStatus,
          exit_code: exitCode,
          runtime_ms: runtimeMs,
        }, endedStatus)
      }
      await opts.registry
        .update(entity_id, {
          status: endedStatus,
          result_file: resultFile,
          exit_code: exitCode,
          ended_at: new Date().toISOString(),
        } as Partial<BgAgentRegistryRecord>)
        .catch(() => {})
      if (opts.onExit) {
        try {
          opts.onExit({
            entity_id,
            task_description: opts.task_description,
            status: endedStatus,
            exit_code: exitCode,
            runtime_ms: runtimeMs,
            spawned_at: now,
            result_file: resultFile,
          })
        } catch (err) {
          console.error(`[bg-agent] onExit callback failed for ${entity_id}:`, err)
        }
      }
    } catch {
      // Handles both abort and unexpected errors.
      // registry.update's status-guard prevents overwriting an already-killed entry.
      const runtimeMs = Date.now() - agentSpawnedAtMs
      if (opts.traceContext) {
        emitInstantSpan(opts.traceContext, 'bg_entity_exit', {
          entity_id,
          type: 'agent',
          status: 'failed',
          exit_code: 1,
          runtime_ms: runtimeMs,
        }, 'failed')
      }
      await opts.registry
        .update(entity_id, {
          status: 'failed' as const,
          exit_code: 1,
          ended_at: new Date().toISOString(),
        } as Partial<BgAgentRegistryRecord>)
        .catch(() => {})
      if (opts.onExit) {
        try {
          opts.onExit({
            entity_id,
            task_description: opts.task_description,
            status: 'failed',
            exit_code: 1,
            runtime_ms: runtimeMs,
            spawned_at: now,
            result_file: null,
          })
        } catch (err) {
          console.error(`[bg-agent] onExit callback failed for ${entity_id}:`, err)
        }
      }
    } finally {
      opts.abortControllers.delete(entity_id)
    }
  })()

  return entity_id
}
