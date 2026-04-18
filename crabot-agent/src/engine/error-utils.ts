// Walk the Error.cause chain so undici's generic "fetch failed" / "terminated"
// messages expose the underlying socket/DNS/timeout reason.
export function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)

  const parts: string[] = []
  const seen = new Set<unknown>()
  let cur: unknown = err

  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur)
    const code = (cur as Error & { code?: unknown }).code
    const codeTag = typeof code === 'string' ? code : ''
    const name = cur.name && cur.name !== 'Error' ? cur.name : ''
    const tag = [name, codeTag].filter(Boolean).join(' ')
    parts.push(tag ? `${tag}: ${cur.message}` : cur.message)
    cur = (cur as Error & { cause?: unknown }).cause
  }

  if (cur !== undefined && !(cur instanceof Error)) {
    parts.push(String(cur))
  }

  return parts.join(' → ')
}
