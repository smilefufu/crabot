const SENSITIVE_FIELD_PATTERNS: ReadonlyArray<RegExp> = [
  /^apikey$/i,
  /^api[-_]?key$/i,
  /^password$/i,
  /^secret$/i,
  /^access[-_]?token$/i,
  /^refresh[-_]?token$/i,
  /^client[-_]?secret$/i,
  /^webhook[-_]?secret$/i,
]

export function maskValue(value: string): string {
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some(p => p.test(key))
}

export function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskSensitive)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && typeof v === 'string') {
        out[k] = maskValue(v)
      } else {
        out[k] = maskSensitive(v)
      }
    }
    return out
  }
  return value
}
