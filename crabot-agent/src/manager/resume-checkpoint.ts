import {
  createAssistantMessage,
  type EngineMessage,
  type EngineLlmResponseEvent,
  type EngineToolLifecycleEvent,
  type EngineTurnEvent,
} from '../engine/types.js'
import type { TimedWakeEnvelope } from './loop.js'
import type { ManagerSessionState } from './types.js'
import type { ManagerToolProfile } from './tools/tool-catalog.js'
import { isDeepStrictEqual } from 'node:util'
import { completeToolUseMessages, unknownToolResult } from '../engine/tool-message-integrity.js'

/** Private execution state; never returned by the Manager read model. */
export interface ManagerResumeCheckpoint {
  readonly episodeId: string
  readonly state: ManagerSessionState
  readonly envelopes: ReadonlyArray<TimedWakeEnvelope>
  readonly wakeIndex: number
  readonly pending: ReadonlyArray<TimedWakeEnvelope>
  /** Profile fixed at episode admission; older checkpoints infer it from wake envelopes. */
  readonly toolProfile?: ManagerToolProfile
  readonly hasEngineMessages: boolean
  readonly turns: ReadonlyArray<EngineTurnEvent>
  readonly responses: ReadonlyArray<EngineLlmResponseEvent>
  readonly tools: ReadonlyArray<EngineToolLifecycleEvent>
  /** Calls whose results have not yet been committed to state.recent. */
  readonly pendingToolCallIds: ReadonlyArray<string>
  readonly protectedTailMessageId?: string
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
  const pending = new Set(checkpoint.pendingToolCallIds)
  const results = new Set(checkpoint.state.recent.flatMap((message) =>
    'toolResults' in message ? message.toolResults.map((result) => result.tool_use_id) : [],
  ))
  const tools = checkpoint.tools.filter((event) => pending.has(event.callId) && !results.has(event.toolUseId))
  const existingCalls = new Set(checkpoint.state.recent.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool_use').map(block => block.id) : []))
  const uncommittedCalls = tools.filter(event => !existingCalls.has(event.toolUseId))
  const messages = uncommittedCalls.length === 0 ? checkpoint.state.recent : [
    ...checkpoint.state.recent,
    createAssistantMessage(uncommittedCalls.map(event => ({
      type: 'tool_use' as const, id: event.toolUseId, name: event.name, input: event.input,
    })), 'tool_use'),
  ]
  // Preserve an existing call rather than duplicating it when its result was not committed.
  return completeToolUseMessages(messages, block => {
    const event = tools.find(candidate => candidate.toolUseId === block.id && candidate.name === block.name
      && isDeepStrictEqual(candidate.input, block.input))
    if (!event) return unknownToolResult(block)
    return { tool_use_id: block.id,
      content: event.type === 'tool_finished' ? event.output : '[interrupted: agent restarted]',
      is_error: event.type === 'tool_finished' ? event.isError : true }
  })
}
