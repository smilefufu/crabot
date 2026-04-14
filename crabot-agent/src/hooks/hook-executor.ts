import type { HookDefinition, HookInput, HookResult, HookExecutorContext } from './types'
import { executeCommandHook } from './command-hook'
import { runPromptHook } from './prompt-hook'

const EMPTY_RESULT: HookResult = { action: 'continue' }
const MESSAGE_SEPARATOR = '\n---\n'

export async function executeHooks(
  hooks: ReadonlyArray<HookDefinition>,
  input: HookInput,
  context: HookExecutorContext,
): Promise<HookResult> {
  if (hooks.length === 0) return EMPTY_RESULT

  const results = await Promise.all(
    hooks.map((hook) => executeSingleHook(hook, input, context))
  )

  return mergeResults(results)
}

async function executeSingleHook(
  hook: HookDefinition,
  input: HookInput,
  context: HookExecutorContext,
): Promise<HookResult> {
  try {
    if (hook.type === 'command') {
      return await executeCommandHook(hook, input, {
        workingDirectory: context.workingDirectory,
        lspManager: context.lspManager,
      })
    }

    if (hook.type === 'prompt' && context.adapter && hook.prompt) {
      return await runPromptHook({
        prompt: hook.prompt,
        input,
        adapter: context.adapter,
        model: hook.model ?? context.model ?? '',
      })
    }

    return EMPTY_RESULT
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { action: 'continue', message: `Hook execution error: ${message}` }
  }
}

function mergeResults(results: ReadonlyArray<HookResult>): HookResult {
  let action: 'continue' | 'block' = 'continue'
  const messages: string[] = []
  let modifiedInput: Record<string, unknown> | undefined

  for (const result of results) {
    if (result.action === 'block') {
      action = 'block'
    }
    if (result.message !== undefined) {
      messages.push(result.message)
    }
    if (result.modifiedInput !== undefined) {
      modifiedInput = { ...modifiedInput, ...result.modifiedInput }
    }
  }

  return {
    action,
    message: messages.length > 0 ? messages.join(MESSAGE_SEPARATOR) : undefined,
    modifiedInput,
  }
}
