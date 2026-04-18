import { createUserMessage } from '../engine/types.js'
import { callNonStreaming, extractText } from '../engine/llm-adapter-types.js'
import type { LLMAdapter } from '../engine/llm-adapter-types.js'
import type { HookInput, HookResult } from './types.js'

const SYSTEM_PROMPT =
  'You are a code quality checker. Evaluate the given tool input and respond with JSON only. ' +
  'If the action should be blocked, respond with {"action":"block","message":"<reason>"}. ' +
  'If the action is safe to continue, respond with {"action":"continue"}. ' +
  'Do not include any text outside the JSON object.'

export interface RunPromptHookParams {
  readonly prompt: string
  readonly input: HookInput
  readonly adapter: LLMAdapter
  readonly model: string
  readonly maxTokens?: number
}

export async function runPromptHook(params: RunPromptHookParams): Promise<HookResult> {
  const { prompt, input, adapter, model, maxTokens } = params

  const resolvedPrompt = prompt.replace('$INPUT', JSON.stringify(input))

  const messages = [createUserMessage(resolvedPrompt)]

  const response = await callNonStreaming(adapter, {
    messages,
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    model,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  })

  return parseHookResult(extractText(response.content))
}

function parseHookResult(text: string): HookResult {
  const trimmed = text.trim()

  if (!trimmed) {
    return { action: 'continue' }
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'action' in parsed
    ) {
      const obj = parsed as Record<string, unknown>
      const action = obj['action']

      if (action === 'block') {
        const message = typeof obj['message'] === 'string' ? obj['message'] : undefined
        return { action: 'block', ...(message !== undefined ? { message } : {}) }
      }

      if (action === 'continue') {
        return { action: 'continue' }
      }
    }
  } catch {
    // Not valid JSON — graceful fallback
  }

  return { action: 'continue', message: trimmed }
}
