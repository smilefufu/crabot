import type { HookDefinition, HookEvent, HookInput } from './types'

interface CompiledHook {
  readonly definition: HookDefinition
  readonly matcherRegex?: RegExp
}

export class HookRegistry {
  private readonly hooks: CompiledHook[] = []

  register(hook: HookDefinition): void {
    this.hooks.push(compile(hook))
  }

  registerAll(hooks: ReadonlyArray<HookDefinition>): void {
    for (const hook of hooks) {
      this.hooks.push(compile(hook))
    }
  }

  isEmpty(): boolean {
    return this.hooks.length === 0
  }

  getMatching(event: HookEvent, input: HookInput): ReadonlyArray<HookDefinition> {
    return this.hooks
      .filter((compiled) => {
        const hook = compiled.definition
        if (hook.event !== event) return false
        if (event === 'Stop') return true

        if (compiled.matcherRegex && input.toolName !== undefined) {
          if (!compiled.matcherRegex.test(input.toolName)) return false
        }

        if (hook.if !== undefined && input.filePaths !== undefined) {
          if (!matchIfCondition(hook.if, input.filePaths)) return false
        }

        return true
      })
      .map((compiled) => compiled.definition)
  }
}

function compile(hook: HookDefinition): CompiledHook {
  return {
    definition: hook,
    matcherRegex: hook.matcher !== undefined ? new RegExp(`^(?:${hook.matcher})$`) : undefined,
  }
}

function matchIfCondition(condition: string, filePaths: ReadonlyArray<string>): boolean {
  const match = condition.match(/\(([^)]+)\)/)
  if (!match) return true
  const pattern = match[1]
  const extMatch = pattern.match(/^\*(\.\w+)$/)
  if (!extMatch) return true
  const extension = extMatch[1]
  return filePaths.some((fp) => fp.endsWith(extension))
}
