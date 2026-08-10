import { createHash } from 'node:crypto'

/** RFC 8785 JSON Canonicalization Scheme for I-JSON values. */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value)
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex')
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      assertWellFormedUnicode(value, 'string')
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
      return JSON.stringify(value)
    case 'object':
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          if (!(index in value)) throw new TypeError('canonical JSON rejects sparse arrays')
        }
        return `[${value.map(canonicalize).join(',')}]`
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError('canonical JSON only accepts plain objects')
      }
      return `{${Object.keys(value as Record<string, unknown>)
        .map((key) => {
          assertWellFormedUnicode(key, 'object key')
          return key
        })
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
        .join(',')}}`
    default:
      throw new TypeError('canonical JSON only accepts JSON values')
  }
}

function assertWellFormedUnicode(value: string, kind: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`canonical JSON rejects unpaired surrogate in ${kind}`)
      index++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`canonical JSON rejects unpaired surrogate in ${kind}`)
    }
  }
}
