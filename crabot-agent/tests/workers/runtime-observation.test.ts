import { expect, it } from 'vitest'
import { BuiltinRuntimeObservation } from '../../src/workers/builtin/runtime-observation.js'
import type { WorkerRuntimeEvent } from '../../src/workers/types.js'

it('keeps per-attempt facts, wait state and terminal failure without treating input as progress', () => {
  const events: WorkerRuntimeEvent[] = []
  const runtime = new BuiltinRuntimeObservation('inc-1', (event) => events.push(event))
  const request = { requestId: 'req-1', callId: 'call-1', attempt: 1, model: 'model', toolCount: 0, startedAtMs: 100 }
  runtime.request({ ...request, status: 'running' }, 'inference')
  const observed = runtime.snapshot().last_observed_at
  runtime.inputs(2, 1)
  expect(runtime.snapshot()).toMatchObject({ phase: 'llm_request', last_observed_at: observed, pending_inputs: { normal: 2, priority: 1 } })
  runtime.request({ ...request, status: 'failed', endedAtMs: 200, error: '502' }, 'inference')
  runtime.request({ ...request, status: 'failed', phase: 'retry_wait', observedAtMs: 200, retryMode: 'connection_recovery', delayMs: 5000, error: '502' }, 'inference')
  expect(runtime.snapshot()).toMatchObject({ phase: 'retry_wait', retry: { retry_mode: 'connection_recovery', delay_ms: 5000 } })
  expect(runtime.snapshot().retry).not.toHaveProperty('max_attempts')
  runtime.stage('ended', '502; exhausted')
  expect(runtime.snapshot()).toMatchObject({ phase: 'ended', error: '502; exhausted', request: { request_id: 'req-1' } })
  expect(events[0].runtime.phase).toBe('llm_request')
  expect(events[0].runtime.pending_inputs).toBeUndefined()
})

it('observer failure is a degraded observation, and separate instances never share state', () => {
  const first = new BuiltinRuntimeObservation('a', () => { throw new Error('disk') })
  const second = new BuiltinRuntimeObservation('b', () => {})
  expect(() => first.stage('preparing')).not.toThrow()
  expect(first.snapshot().unavailable_reason).toBeTruthy()
  expect(second.snapshot()).toMatchObject({ incarnation_id: 'b', phase: 'unknown' })
})

it('tracks concurrent tools independently and correlates compaction requests to their operation', () => {
  const events: WorkerRuntimeEvent[] = []
  const runtime = new BuiltinRuntimeObservation('inc', event => events.push(event))
  const base = { responseId: 'response', toolUseId: 'tool', input: {}, turnNumber: 1 }
  runtime.tool({ ...base, type: 'tool_started', callId: 'a', name: 'read', startedAtMs: 100 })
  runtime.tool({ ...base, type: 'tool_started', callId: 'b', name: 'bash', startedAtMs: 200 })
  runtime.tool({ ...base, type: 'tool_finished', callId: 'a', name: 'read', startedAtMs: 100, endedAtMs: 300, durationMs: 200, output: '', isError: false })
  expect(runtime.snapshot()).toMatchObject({ phase: 'tools', tools: [{ call_id: 'b' }] })
  runtime.compaction(true)
  runtime.request({ requestId: 'r', callId: 'c', attempt: 1, model: 'model', toolCount: 0, startedAtMs: 400, status: 'running' }, 'compaction')
  runtime.compaction(false)
  expect(new Set(events.map(event => event.operation_id)).size).toBe(1)
  expect(events[0].operation_id).toBeTruthy()
  runtime.stage('idle')
  expect(events.at(-1)?.operation_id).toBeUndefined()
})
