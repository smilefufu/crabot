/**
 * Generate a deterministic HSL color from a string identifier.
 * Useful for avatar backgrounds, participant indicators, etc.
 */
export function colorFromId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 42%, 48%)`
}
