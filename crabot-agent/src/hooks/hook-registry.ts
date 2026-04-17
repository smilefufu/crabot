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

        if (hook.if !== undefined) {
          if (!matchIfCondition(hook.if, input)) return false
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

/**
 * 匹配 if 条件。支持两种格式：
 * - "ToolName(*.ext)"  — 文件扩展名匹配（如 "Edit(*.ts)"）
 * - "Bash(command *)"  — Bash 命令前缀匹配（如 "Bash(crabot *)"）
 */
function matchIfCondition(condition: string, input: HookInput): boolean {
  const match = condition.match(/^(\w+)\(([^)]+)\)$/)
  if (!match) return true
  const [, toolName, pattern] = match

  // 文件扩展名匹配：Edit(*.ts), Write(*.js) 等
  const extMatch = pattern.match(/^\*(\.\w+)$/)
  if (extMatch) {
    const extension = extMatch[1]
    return (input.filePaths ?? []).some((fp) => fp.endsWith(extension))
  }

  // Bash 命令前缀匹配：Bash(crabot *) 等
  if (toolName === 'Bash' && input.toolInput) {
    const command = typeof input.toolInput.command === 'string'
      ? input.toolInput.command.trim()
      : ''
    // "crabot *" → 匹配以 "crabot" 开头的命令
    const prefix = pattern.replace(/\s*\*$/, '')
    return command.startsWith(prefix)
  }

  // 未识别的 pattern 格式，不匹配（安全默认）
  return false
}
