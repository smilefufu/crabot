import type { HookDefinition, HookEvent, HookInput } from './types'

export class HookRegistry {
  private readonly hooks: HookDefinition[] = []

  register(hook: HookDefinition): void {
    this.hooks.push(hook)
  }

  registerAll(hooks: ReadonlyArray<HookDefinition>): void {
    for (const hook of hooks) {
      this.hooks.push(hook)
    }
  }

  isEmpty(): boolean {
    return this.hooks.length === 0
  }

  getMatching(event: HookEvent, input: HookInput): ReadonlyArray<HookDefinition> {
    return this.hooks.filter((hook) => {
      if (hook.event !== event) return false
      if (event === 'Stop') return true

      if (hook.matcher !== undefined && input.toolName !== undefined) {
        const regex = new RegExp(`^(?:${hook.matcher})$`)
        if (!regex.test(input.toolName)) return false
      }

      if (hook.if !== undefined && input.filePaths !== undefined) {
        if (!matchIfCondition(hook.if, input.filePaths)) return false
      }

      return true
    })
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
