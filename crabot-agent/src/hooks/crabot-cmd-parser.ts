export interface ParsedCrabotCommand {
  readonly subcommand: string  // e.g. 'provider delete', 'mcp toggle', 'agent set-model'
  readonly flags: Record<string, string>
  readonly hasReveal: boolean
}

// 匹配 crabot 调用：开头、空格后、&& 后、绝对路径前缀都允许
const CRABOT_INVOCATION_RE = /(?:^|\s|&&\s*)(?:[/\w.-]*\/)?crabot(?:\.mjs)?\s+(.+)/

export function parseCrabotInvocation(commandLine: string): ParsedCrabotCommand | null {
  const m = commandLine.match(CRABOT_INVOCATION_RE)
  if (!m) return null
  const tail = m[1]!.trim()
  const tokens = tail.split(/\s+/)

  // 取前 1-2 个非 flag tokens 作为 subcommand
  const subTokens: string[] = []
  let i = 0
  while (i < tokens.length && !tokens[i]!.startsWith('-')) {
    subTokens.push(tokens[i]!)
    i++
    if (subTokens.length === 2) break
  }

  // flags
  const flags: Record<string, string> = {}
  let hasReveal = false
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (tok === '--reveal') { hasReveal = true; i++; continue }
    if (tok.startsWith('--') || tok.startsWith('-')) {
      const next = tokens[i + 1]
      if (next && !next.startsWith('-')) {
        flags[tok] = next
        i += 2
      } else {
        flags[tok] = ''
        i++
      }
    } else {
      i++
    }
  }

  return { subcommand: subTokens.join(' '), flags, hasReveal }
}
