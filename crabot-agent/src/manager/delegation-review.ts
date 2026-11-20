import { createHash } from 'node:crypto'
import { callNonStreaming } from '../engine/llm-adapter.js'
import { createUserMessage, type EngineMessage, type ToolBatchContext, type ToolDefinition } from '../engine/types.js'
import type { ChannelMessage } from '../types.js'
import { DELEGATION_REVIEW_PROMPT } from './delegation-review-prompt.js'

const DISPATCH_TOOLS = new Set(['spawn_worker', 'send_to_worker'])
/** 同一派工方案（批次内容指纹）被拒上限；真改过的方案重新计数。 */
const MAX_REJECTS_PER_BATCH = 2
/** 单 episode 真复核 LLM 调用总上限，防无意义微调无限续命。 */
const MAX_REVIEWS_PER_EPISODE = 5
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
interface ReviewIssue {
  call_ids: string[]
  source_quote: string
  handoff_quote: string
  impact: string
}
interface ReviewVerdict {
  verdict: 'allow' | 'revise' | 'uncertain'
  issues: ReviewIssue[]
}
export interface DelegationReviewObservation {
  snapshotSha256: string
  callIds: string[]
  verdict?: ReviewVerdict
  technical_error?: string
}

export function parseDelegationReview(text: string, callIds: ReadonlySet<string>): ReviewVerdict {
  const value = JSON.parse(text)
  if (!value || !['allow', 'revise', 'uncertain'].includes(value.verdict) || !Array.isArray(value.issues)
    || (value.verdict === 'allow') !== (value.issues.length === 0)) throw new Error('Invalid review verdict')
  for (const issue of value.issues) {
    if (!issue || !Array.isArray(issue.call_ids) || !issue.call_ids.length
      || issue.call_ids.some((id: unknown) => typeof id !== 'string' || !callIds.has(id))
      || !['source_quote', 'handoff_quote', 'impact'].every(key => typeof issue[key] === 'string')
      || !issue.source_quote || !issue.impact) throw new Error('Invalid review attribution/evidence')
  }
  return value
}

/** Match only host-rendered, visible human input. Retained sources follow the existing history lifetime. */
export function attachManagerHumanSources(
  messages: ReadonlyArray<EngineMessage>,
  sources: ReadonlyArray<{ text: string; messages: ReadonlyArray<ChannelMessage> }>,
): EngineMessage[] {
  return messages.map(message => {
    if (message.role !== 'user' || !('content' in message) || message.managerHumanSource) return message
    let text: string | undefined
    if (typeof message.content === 'string') text = message.content
    else if (message.content[0]?.type === 'text') text = message.content[0].text
    const source = sources.find(source => source.text === text)
    return source ? { ...message, managerHumanSource: structuredClone(source.messages) } : message
  })
}

function visibleMessages(messages: ReadonlyArray<EngineMessage>): unknown[] {
  return messages.map(message => {
    if (message.role === 'user' && 'content' in message) {
      const { managerHumanSource: _source, ...visible } = message
      return visible
    }
    if (message.role !== 'assistant') return message
    const { providerState: _nativeState, ...visible } = message
    return { ...visible, content: message.content.filter(block => block.type !== 'raw_reasoning') }
  })
}

/** One gate per Manager engine attempt; no shared global state and no tool authority of its own. */
export function createDelegationReview(options: {
  readonly sources: () => ReadonlyArray<{ text: string; messages: ReadonlyArray<ChannelMessage> }>
  readonly inputRevision: () => string
  readonly observe: (observation: DelegationReviewObservation) => void
}) {
  /** 批次内容指纹 → 已被拒次数；仅拒绝时递增，gate 生命周期内不清零。 */
  const batchRejects = new Map<string, number>()
  let reviewCount = 0
  return async (context: ToolBatchContext): Promise<ReadonlyArray<ToolDefinition>> => {
    const dispatches = context.calls.filter(call => DISPATCH_TOOLS.has(call.name))
    if (!dispatches.length) return context.tools
    const batchKey = fingerprint(dispatches.map(call => [call.name, call.input]))
    const rejectCount = batchRejects.get(batchKey) ?? 0
    const closedReason = rejectCount >= MAX_REJECTS_PER_BATCH ? 'repeat'
      : reviewCount >= MAX_REVIEWS_PER_EPISODE ? 'budget' : undefined
    const snapshotMessages = attachManagerHumanSources(context.messages, options.sources())
    const snapshot = {
      originalSource: snapshotMessages.flatMap(message => message.role === 'user' && 'managerHumanSource' in message ? message.managerHumanSource ?? [] : []),
      managerSystem: context.systemPrompt,
      managerMessages: visibleMessages(snapshotMessages),
      tools: context.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      proposedCalls: structuredClone(context.calls),
    }
    const snapshotSha256 = fingerprint(snapshot)
    const revision = options.inputRevision()
    let verdict: ReviewVerdict | undefined
    let failure: string | undefined
    try {
      if (closedReason) {
        verdict = { verdict: 'uncertain', issues: dispatches.map(call => ({
          call_ids: [call.id], handoff_quote: '', impact: '复核门已关闭。',
          source_quote: closedReason === 'repeat'
            ? `同一派工方案已被拒绝 ${MAX_REJECTS_PER_BATCH} 次`
            : `本回合复核次数已达上限 ${MAX_REVIEWS_PER_EPISODE} 次`,
        })) }
      } else {
        reviewCount++
        const response = await callNonStreaming(context.adapter, {
          systemPrompt: DELEGATION_REVIEW_PROMPT,
          messages: [createUserMessage(JSON.stringify(snapshot))],
          model: context.model, thinking: context.thinking, tools: [], signal: context.signal,
          configChangedSignal: context.configChangedSignal, configGeneration: context.configGeneration, onConfigChanged: context.onConfigChanged,
        })
        if (response.stopReason !== 'end_turn') throw new Error('Review response incomplete: ' + response.stopReason)
        verdict = parseDelegationReview(response.content.filter(block => block.type === 'text').map(block => block.text).join(''), new Set(dispatches.map(call => call.id)))
      }
      if (revision !== options.inputRevision() || context.signal?.aborted
        || fingerprint({ ...snapshot, managerMessages: visibleMessages(attachManagerHumanSources(context.messages, options.sources())), proposedCalls: context.calls }) !== snapshotSha256) {
        throw new Error('Review input changed or cancelled')
      }
    } catch (error) {
      failure = String(error)
    }
    options.observe({ snapshotSha256, callIds: dispatches.map(call => call.id), verdict, technical_error: failure })
    if (!failure && verdict?.verdict === 'allow') return context.tools
    if (!closedReason) batchRejects.set(batchKey, rejectCount + 1)
    return context.tools.map(tool => !DISPATCH_TOOLS.has(tool.name) ? tool : {
      ...tool,
      call: async (_input, callContext) => {
        const call = dispatches.find(call => context.callIds.get(call.id) === callContext.toolCallId)
        const ids = call ? [call.id] : []
        return { isError: true, output: JSON.stringify({
          status: failure ? 'review_unavailable' : closedReason ? 'gate_closed' : verdict!.verdict,
          dispatched: false, batch_deferred: true, affected_call_ids: ids,
          issues: (verdict?.issues ?? []).filter(issue => issue.call_ids.some(id => ids.includes(id))),
          other_call_issues: (verdict?.issues ?? []).filter(issue => !issue.call_ids.some(id => ids.includes(id))),
          technical_error: failure,
          instruction: failure ? '复核接口技术失败，本次未派工；如实报告，不能宣称任务完成。'
            : closedReason === 'repeat' ? `该派工方案已被拒绝 ${MAX_REJECTS_PER_BATCH} 次，复核门已关闭。停止重试该方案，保留结果并直接向用户报告未解决的需求分歧。`
            : closedReason === 'budget' ? `本回合复核次数已达上限 ${MAX_REVIEWS_PER_EPISODE} 次，复核门已关闭。停止重试派工，保留结果并直接向用户报告未解决的需求分歧。`
            : '本批派工尚未执行。结合全批分工修订后重新派发；同一问题最多一次修订，仍有争议则报告真实缺口。',
        }) }
      },
    })
  }
}
