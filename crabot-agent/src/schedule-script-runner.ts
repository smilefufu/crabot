import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { buildChildEnv } from './core/runtime-env.js'
import type { TraceStore } from './core/trace-store.js'
import { runHostProcess, terminateHostProcessTreeAndWait, type HostProcessOutcome } from './engine/host-process.js'
import { BASH_NOT_FOUND_MESSAGE, resolveBashPath } from './utils/resolve-bash-path.js'

const OUTPUT_LIMIT_BYTES = 1024 * 1024
const DELIVERY_TAIL_BYTES = 50_000

export interface ScheduleScriptRun {
  scheduleId: string
  triggerId: string
  scheduleName: string
  source: string
  sourceSha256: string
  timeoutSeconds: number
  deliverResult: boolean
  targetSession: { channel_id: string; session_id: string; type: 'private' | 'group' }
  creatorFriendId?: string
  isBuiltin?: boolean
}

export interface ScheduleScriptDelivery extends ScheduleScriptRun {
  startedAt: string
  endedAt: string
  outcome: 'succeeded' | 'failed' | 'interrupted'
  exitCode?: number
  signal?: string
  stdoutBytes: number
  stderrBytes: number
  outputTail: string
}

interface ScheduleScriptActiveMarker {
  schema_version: 1
  schedule_id: string
  trigger_id: string
  source_sha256: string
  pid: number
  process_start_identity: string
  created_at: string
}

export interface ScheduleScriptRunnerDeps {
  traceStore: TraceStore
  moduleId: string
  markerDir: string
  cwd: string
  deliver: (result: ScheduleScriptDelivery) => Promise<void>
  runProcess?: typeof runHostProcess
  readProcessIdentity?: (pid: number) => Promise<string>
  terminateProcess?: (pid: number) => Promise<void>
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', env: buildChildEnv({ LC_ALL: 'C' }) }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** Fail-closed process identity used only for Schedule marker admission and recovery. */
export async function readProcessStartIdentity(pid: number): Promise<string> {
  const output = process.platform === 'win32'
    ? await execText('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ])
    : await execText('ps', ['-o', 'lstart=', '-p', String(pid)])
  const identity = output.trim()
  if (!identity) throw new Error('process identity unavailable')
  return identity
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk])
  if (combined.length <= DELIVERY_TAIL_BYTES) return combined
  let start = combined.length - DELIVERY_TAIL_BYTES
  while (start < combined.length && (combined[start] & 0xc0) === 0x80) start += 1
  return combined.subarray(start)
}

function classifyOutcome(outcome: HostProcessOutcome): {
  status: 'succeeded' | 'failed' | 'interrupted'
  failureKind?: 'spawn_error' | 'nonzero_exit' | 'signal' | 'timeout' | 'output_limit' | 'aborted'
} {
  if (outcome.kind === 'aborted') return { status: 'interrupted', failureKind: 'aborted' }
  if (outcome.kind === 'spawn_error') return { status: 'failed', failureKind: 'spawn_error' }
  if (outcome.kind === 'timed_out') return { status: 'failed', failureKind: 'timeout' }
  if (outcome.kind === 'output_limit') return { status: 'failed', failureKind: 'output_limit' }
  if (outcome.signal) return { status: 'failed', failureKind: 'signal' }
  if (outcome.exitCode !== 0) return { status: 'failed', failureKind: 'nonzero_exit' }
  return { status: 'succeeded' }
}

function markerName(triggerId: string): string {
  return `${encodeURIComponent(triggerId)}.json`
}

function isMarker(value: unknown): value is ScheduleScriptActiveMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const marker = value as Partial<ScheduleScriptActiveMarker>
  return marker.schema_version === 1
    && typeof marker.schedule_id === 'string'
    && typeof marker.trigger_id === 'string'
    && typeof marker.source_sha256 === 'string'
    && typeof marker.pid === 'number'
    && typeof marker.process_start_identity === 'string'
    && typeof marker.created_at === 'string'
}

export class ScheduleScriptRunner {
  private readonly active = new Map<string, { abort: AbortController; completion: Promise<void> }>()
  private readonly admissions = new Map<string, Promise<void>>()
  private closing = false

  constructor(private readonly deps: ScheduleScriptRunnerDeps) {}

  admit(run: ScheduleScriptRun): Promise<void> {
    const previous = this.admissions.get(run.triggerId)
    if (previous) return previous
    const admission = this.admitOnce(run)
    this.admissions.set(run.triggerId, admission)
    return admission
  }

  private async admitOnce(run: ScheduleScriptRun): Promise<void> {
    if (this.closing) throw new Error('Schedule script runner is closing')
    const trace = this.deps.traceStore.startTrace({
      module_id: this.deps.moduleId,
      trigger: {
        type: 'schedule',
        source: run.scheduleId,
        summary: `${run.scheduleName}; trigger=${run.triggerId}; sha256=${run.sourceSha256}`,
      },
    })
    const startedAt = new Date().toISOString()
    const executionSpan = this.deps.traceStore.startSpan(trace.trace_id, {
      type: 'schedule_script_execution',
      details: {
        schedule_id: run.scheduleId,
        trigger_id: run.triggerId,
        source_sha256: run.sourceSha256,
        started_at: startedAt,
        stdout_bytes: 0,
        stderr_bytes: 0,
      },
    })

    if (this.active.has(run.scheduleId)) {
      const endedAt = new Date().toISOString()
      this.deps.traceStore.endSpan(trace.trace_id, executionSpan.span_id, 'completed', {
        outcome: 'skipped',
        ended_at: endedAt,
      })
      this.deps.traceStore.endTrace(trace.trace_id, 'completed', { summary: 'Schedule script skipped: already running' })
      return
    }

    const bash = resolveBashPath()
    if (!bash) {
      this.deps.traceStore.endSpan(trace.trace_id, executionSpan.span_id, 'failed', {
        outcome: 'failed',
        ended_at: new Date().toISOString(),
        failure_kind: 'spawn_error',
      })
      this.deps.traceStore.endTrace(trace.trace_id, 'failed', { summary: 'Schedule script failed to start' })
      throw new Error(BASH_NOT_FOUND_MESSAGE)
    }

    const abort = new AbortController()
    let outputTail: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let markerPath: string | undefined
    let admissionSettled = false
    let resolveAdmission!: () => void
    let rejectAdmission!: (error: Error) => void
    const admission = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve
      rejectAdmission = reject
    })
    const settleAdmission = (error?: Error): void => {
      if (admissionSettled) return
      admissionSettled = true
      if (error) rejectAdmission(error)
      else resolveAdmission()
    }

    const processRun = (this.deps.runProcess ?? runHostProcess)({
      argv: [bash, '--noprofile', '--norc', '-s'],
      cwd: this.deps.cwd,
      env: buildChildEnv(),
      stdin: run.source,
      abortSignal: abort.signal,
      limits: {
        timeoutMs: run.timeoutSeconds * 1000,
        stdoutBytes: OUTPUT_LIMIT_BYTES,
        stderrBytes: OUTPUT_LIMIT_BYTES,
      },
      onStdoutChunk: (chunk) => { outputTail = appendTail(outputTail, chunk) },
      onStderrChunk: (chunk) => { outputTail = appendTail(outputTail, chunk) },
      beforeStdin: async (child: ChildProcess) => {
        try {
          if (child.pid === undefined) throw new Error('Schedule script child has no pid')
          const identity = await (this.deps.readProcessIdentity ?? readProcessStartIdentity)(child.pid)
          this.deps.traceStore.flushRunningTraces()
          markerPath = await this.writeMarker({
            schema_version: 1,
            schedule_id: run.scheduleId,
            trigger_id: run.triggerId,
            source_sha256: run.sourceSha256,
            pid: child.pid,
            process_start_identity: identity,
            created_at: new Date().toISOString(),
          })
          settleAdmission()
        } catch {
          settleAdmission(new Error('Schedule script admission failed'))
          throw new Error('Schedule script admission failed')
        }
      },
    })

    const completion = processRun.then(async (outcome) => {
      if (!admissionSettled) settleAdmission(new Error('Schedule script admission failed'))
      const endedAt = new Date().toISOString()
      const classified = classifyOutcome(outcome)
      this.deps.traceStore.endSpan(trace.trace_id, executionSpan.span_id, classified.status === 'succeeded' ? 'completed' : 'failed', {
        outcome: classified.status,
        ended_at: endedAt,
        ...(outcome.exitCode === null ? {} : { exit_code: outcome.exitCode }),
        ...(outcome.signal ? { signal: outcome.signal } : {}),
        ...(classified.failureKind ? { failure_kind: classified.failureKind } : {}),
        stdout_bytes: outcome.stdoutBytes,
        stderr_bytes: outcome.stderrBytes,
        ...(run.deliverResult ? { output_tail: outputTail.toString('utf8') } : {}),
      })

      const deliverySpan = run.deliverResult
        ? this.deps.traceStore.startSpan(trace.trace_id, {
            type: 'schedule_result_delivery',
            details: {
              schedule_id: run.scheduleId,
              trigger_id: run.triggerId,
              target_session: run.targetSession,
            },
          })
        : undefined
      const traceStatus = classified.status === 'succeeded' ? 'completed' : 'failed'
      const traceSummary = `Schedule script ${classified.status}`
      this.deps.traceStore.endTrace(trace.trace_id, traceStatus, { summary: traceSummary })

      if (deliverySpan) {
        try {
          await this.deps.deliver({
            ...run,
            startedAt,
            endedAt,
            outcome: classified.status,
            ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
            ...(outcome.signal ? { signal: outcome.signal } : {}),
            stdoutBytes: outcome.stdoutBytes,
            stderrBytes: outcome.stderrBytes,
            outputTail: outputTail.toString('utf8'),
          })
          this.deps.traceStore.endSpan(trace.trace_id, deliverySpan.span_id, 'completed', { outcome: 'delivered' })
        } catch {
          this.deps.traceStore.endSpan(trace.trace_id, deliverySpan.span_id, 'failed', {
            outcome: 'failed',
            error: 'Schedule result delivery failed',
          })
        }
        this.deps.traceStore.appendTraceOutcome(trace.trace_id, { summary: traceSummary })
      }
    }).finally(async () => {
      this.active.delete(run.scheduleId)
      if (markerPath) {
        await fs.unlink(markerPath).catch(() => {
          console.warn(`[ScheduleScriptRunner] failed to remove active marker for trigger ${run.triggerId}`)
        })
      }
    })
    this.active.set(run.scheduleId, { abort, completion })
    void completion.catch((error) => {
      if (!admissionSettled) settleAdmission(new Error('Schedule script admission failed'))
      console.error(`[ScheduleScriptRunner] execution settlement failed for trigger ${run.triggerId}:`, error)
    })
    return admission
  }

  async recover(): Promise<void> {
    await fs.mkdir(this.deps.markerDir, { recursive: true, mode: 0o700 })
    const files = (await fs.readdir(this.deps.markerDir)).filter((file) => file.endsWith('.json'))
    for (const file of files) {
      const markerPath = path.join(this.deps.markerDir, file)
      let marker: ScheduleScriptActiveMarker
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(markerPath, 'utf8'))
        if (!isMarker(parsed)) throw new Error('invalid marker')
        marker = parsed
      } catch {
        console.warn('[ScheduleScriptRunner] ignored invalid active marker')
        continue
      }

      const trace = this.deps.traceStore.getTraces(1000, 0).traces.find((candidate) =>
        candidate.spans.some((span) => span.type === 'schedule_script_execution'
          && (span.details as { trigger_id?: string }).trigger_id === marker.trigger_id),
      )
      const executionSpan = trace?.spans.find((span) => span.type === 'schedule_script_execution')
      const deliverySpan = trace?.spans.find((span) => span.type === 'schedule_result_delivery' && span.status === 'running')

      if (!executionSpan || executionSpan.status === 'running') {
        try {
          const actual = await (this.deps.readProcessIdentity ?? readProcessStartIdentity)(marker.pid)
          if (actual === marker.process_start_identity) {
            await (this.deps.terminateProcess ?? terminateHostProcessTreeAndWait)(marker.pid)
          } else {
            console.warn(`[ScheduleScriptRunner] process identity mismatch for trigger ${marker.trigger_id}; pid not signalled`)
          }
        } catch {
          // Missing process or unavailable identity is never a reason to signal an unverified PID.
          console.warn(`[ScheduleScriptRunner] process identity unavailable for trigger ${marker.trigger_id}; pid not signalled`)
        }
      }

      if (trace && executionSpan?.status === 'running') {
        this.deps.traceStore.endSpan(trace.trace_id, executionSpan.span_id, 'failed', {
          outcome: 'interrupted',
          ended_at: new Date().toISOString(),
          failure_kind: 'recovery',
        })
      }
      if (trace && deliverySpan) {
        this.deps.traceStore.endSpan(trace.trace_id, deliverySpan.span_id, 'failed', {
          outcome: 'interrupted',
          error: 'Schedule result delivery interrupted by Agent restart',
        })
      }
      if (trace) {
        this.deps.traceStore.appendTraceOutcome(trace.trace_id, {
          summary: executionSpan?.status === 'completed' ? (trace.outcome?.summary ?? 'Schedule script completed') : 'Schedule script interrupted',
        })
      } else {
        const recovered = this.deps.traceStore.startTrace({
          module_id: this.deps.moduleId,
          trigger: {
            type: 'schedule',
            source: marker.schedule_id,
            summary: `${marker.schedule_id}; trigger=${marker.trigger_id}; sha256=${marker.source_sha256}`,
          },
        })
        const span = this.deps.traceStore.startSpan(recovered.trace_id, {
          type: 'schedule_script_execution',
          details: {
            schedule_id: marker.schedule_id,
            trigger_id: marker.trigger_id,
            source_sha256: marker.source_sha256,
            outcome: 'interrupted',
            started_at: marker.created_at,
            ended_at: new Date().toISOString(),
            failure_kind: 'recovery',
            stdout_bytes: 0,
            stderr_bytes: 0,
          },
        })
        this.deps.traceStore.endSpan(recovered.trace_id, span.span_id, 'failed')
        this.deps.traceStore.endTrace(recovered.trace_id, 'failed', { summary: 'Schedule script interrupted' })
      }
      await fs.unlink(markerPath)
    }
  }

  async stop(): Promise<void> {
    this.closing = true
    const active = [...this.active.values()]
    for (const item of active) item.abort.abort()
    await Promise.allSettled(active.map((item) => item.completion))
  }

  private async writeMarker(marker: ScheduleScriptActiveMarker): Promise<string> {
    await fs.mkdir(this.deps.markerDir, { recursive: true, mode: 0o700 })
    const target = path.join(this.deps.markerDir, markerName(marker.trigger_id))
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      await fs.rename(temporary, target)
      await fs.chmod(target, 0o600)
    } catch (error) {
      await fs.unlink(temporary).catch(() => {})
      throw error
    }
    return target
  }
}
