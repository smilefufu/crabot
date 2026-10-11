import { createBatchToolResultMessage, type EngineMessage, type EngineToolResultMessage, type ToolUseBlock } from './types.js'

export type ToolMessageIntegrity =
  | { ok: true }
  | { ok: false; danglingToolUseIds: string[] }

export function checkToolMessageIntegrity(messages: ReadonlyArray<EngineMessage>): ToolMessageIntegrity {
  const open = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          open.add(block.id)
        }
      }
      continue
    }

    if ('toolResults' in message) {
      for (const result of message.toolResults) {
        open.delete(result.tool_use_id)
      }
    }
  }

  if (open.size === 0) return { ok: true }
  return { ok: false, danglingToolUseIds: [...open] }
}

export function hasDanglingToolUse(messages: ReadonlyArray<EngineMessage>): boolean {
  return !checkToolMessageIntegrity(messages).ok
}

type ToolResult = EngineToolResultMessage['toolResults'][number]

export function unknownToolResult(block: ToolUseBlock): ToolResult {
  return { tool_use_id: block.id, is_error: true,
    content: '[unknown: original tool result is missing; execution and side effects cannot be confirmed. Do not automatically replay this call.]' }
}

/** Repair only uniquely missing results. Never move, remove or replay a call. */
export function completeToolUseMessages(
  messages: ReadonlyArray<EngineMessage>,
  missingResult: (block: ToolUseBlock) => ToolResult = unknownToolResult,
): EngineMessage[] {
  const calls = new Map<string, number>()
  const results = new Map<string, number>()
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        if (!block.id || calls.has(block.id)) throw new Error(`Invalid tool history: duplicate or empty tool_use ID ${block.id}`)
        calls.set(block.id, index)
      }
    } else if ('toolResults' in message) {
      for (const result of message.toolResults) {
        if (results.has(result.tool_use_id)) throw new Error(`Invalid tool history: duplicate tool_result ${result.tool_use_id}`)
        results.set(result.tool_use_id, index)
      }
    }
  }
  for (const [id, resultIndex] of results) {
    const callIndex = calls.get(id)
    if (callIndex === undefined || resultIndex <= callIndex) throw new Error(`Invalid tool history: unmatched tool_result ${id}`)
    for (let index = callIndex + 1; index <= resultIndex; index++) {
      if (!('toolResults' in messages[index])) throw new Error(`Invalid tool history: out-of-order tool_result ${id}`)
    }
  }

  const completed: EngineMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    completed.push(message)
    if (message.role !== 'assistant') continue
    const missing = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use' && !results.has(block.id))
    if (missing.length === 0) continue
    while (index + 1 < messages.length && 'toolResults' in messages[index + 1]) completed.push(messages[++index])
    const added = missing.map(block => {
      const result = missingResult(block)
      if (result.tool_use_id !== block.id) throw new Error(`Invalid tool history: mismatched repair result ${block.id}`)
      return result
    })
    const last = completed[completed.length - 1]
    // Keep a partial batch together: adapters emit all outputs before its image payloads.
    if ('toolResults' in last) completed[completed.length - 1] = { ...last, toolResults: [...last.toolResults, ...added] }
    else completed.push(createBatchToolResultMessage(added))
  }
  return completed
}

export function assertToolMessageIntegrity(messages: ReadonlyArray<EngineMessage>): void {
  completeToolUseMessages(messages, block => {
    throw new Error(`Invalid tool history: missing tool_result ${block.id}`)
  })
}
