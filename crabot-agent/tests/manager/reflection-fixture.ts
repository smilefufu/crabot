import type { DailyReflection } from '../../src/manager/daily-reflection.js'
import type { ToolTraceMetadata } from '../../src/engine/types.js'

// Source and completion tests assume saved tool results; pagination tests exercise the unsaved boundary.
async function acknowledge(host: DailyReflection, name: string, input: Record<string, unknown>, traceMetadata?: ToolTraceMetadata) {
  await host.acknowledgePages([{ type: 'tool_finished', name, input, traceMetadata, output: '', isError: false,
    callId: 'fixture', toolUseId: 'fixture', responseId: 'fixture', turnNumber: 0, startedAtMs: 0, endedAtMs: 1, durationMs: 1 }])
}

export async function listPage(host: DailyReflection, restart = false) {
  const result = await host.list(restart)
  await acknowledge(host, 'list_reflection_records', { restart }, result.traceMetadata)
  return result.output
}

export async function readPage(host: DailyReflection, record_ref: string, restart = false) {
  const result = await host.read(record_ref, restart)
  await acknowledge(host, 'read_reflection_record', { record_ref, restart }, result.traceMetadata)
  return result.output
}
