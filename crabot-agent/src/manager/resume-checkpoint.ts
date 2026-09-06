import {
  createAssistantMessage,
  createBatchToolResultMessage,
  type EngineMessage,
  type EngineLlmResponseEvent,
  type EngineToolLifecycleEvent,
  type EngineTurnEvent,
} from '../engine/types.js'
import type { TimedWakeEnvelope } from './loop.js'
import type { ManagerSessionState } from './types.js'

/** Private execution state; never returned by the Manager read model. */
export interface ManagerResumeCheckpoint {
  readonly episodeId: string
  readonly state: ManagerSessionState
  readonly envelopes: ReadonlyArray<TimedWakeEnvelope>
  readonly wakeIndex: number
  readonly pending: ReadonlyArray<TimedWakeEnvelope>
  readonly hasEngineMessages: boolean
  readonly turns: ReadonlyArray<EngineTurnEvent>
  readonly responses: ReadonlyArray<EngineLlmResponseEvent>
  readonly tools: ReadonlyArray<EngineToolLifecycleEvent>
  readonly adminChatClaims: ReadonlyArray<readonly [string, 'unclaimed' | 'claimed']>
  readonly transientMessageIds: ReadonlyArray<string>
  readonly spawnedWorkerIds: ReadonlyArray<string>
  readonly execution: {
    readonly needsSpawnRecheck: boolean
    readonly spawnRecheckInjected: boolean
    readonly spawnRecheckOutcomeRecorded: boolean
    readonly postSendRecheckSequence: number
    readonly successfulSendMessageTargets: ReadonlyArray<string>
    readonly continuedWorkers: ReadonlyArray<string>
  }
}

export function settleInterruptedManagerTools(checkpoint: ManagerResumeCheckpoint): ManagerResumeCheckpoint {
  const endedAtMs = Date.now()
  return {
    ...checkpoint,
    tools: checkpoint.tools.map((event) => event.type === 'tool_finished' ? event : {
      ...event, type: 'tool_finished', output: '[interrupted: agent restarted]', isError: true,
      endedAtMs, durationMs: endedAtMs - event.startedAtMs,
    }),
  }
}

export function resumeManagerMessages(checkpoint: ManagerResumeCheckpoint): ReadonlyArray<EngineMessage> {
  const results = new Set(checkpoint.state.recent.flatMap((message) =>
    'toolResults' in message ? message.toolResults.map((result) => result.tool_use_id) : [],
  ))
  const tools = checkpoint.tools.filter((event) => !results.has(event.toolUseId))
  if (tools.length === 0) return checkpoint.state.recent
  // Completed calls keep their real results. An interrupted call is not executed again by recovery.
  return [
    ...checkpoint.state.recent,
    createAssistantMessage(tools.map((event) => ({
      type: 'tool_use' as const, id: event.toolUseId, name: event.name, input: event.input,
    })), 'tool_use'),
    createBatchToolResultMessage(tools.map((event) => ({
      tool_use_id: event.toolUseId,
      content: event.type === 'tool_finished' ? event.output : '[interrupted: agent restarted]',
      is_error: event.type === 'tool_finished' ? event.isError : true,
    }))),
  ]
}
