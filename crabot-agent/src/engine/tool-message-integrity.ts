import type { EngineMessage } from './types.js'

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
