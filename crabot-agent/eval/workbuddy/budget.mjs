// Counts provider-native usage, including cached input, without adding an output cap.
export const TOTAL_BUDGET = 120_000_000
export const REQUEST_RESERVE = 10_000_000
export function nativeUsage(u) {
  if (!u || !Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens)
    || u.prompt_tokens < 0 || u.completion_tokens < 0) throw new Error('Provider usage missing or invalid')
  return { input: u.prompt_tokens, output: u.completion_tokens,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
    total: u.prompt_tokens + u.completion_tokens }
}
export class Budget {
  constructor(limit, used = 0, reserved = 0) {
    if (!Number.isFinite(limit) || limit > TOTAL_BUDGET || !Number.isFinite(used) || !Number.isFinite(reserved) || reserved < 0 || limit <= used + reserved || used < 0) throw new Error('Invalid evaluation budget')
    this.limit = limit; this.used = used; this.reserved = reserved; this.pending = new Set(); this.blocked = false
  }
  begin(id) {
    if (this.blocked || this.pending.size || this.limit - this.used - this.reserved < REQUEST_RESERVE) throw new Error('Budget admission stopped')
    this.pending.add(id)
  }
  finish(id, usage) {
    if (!this.pending.delete(id)) throw new Error('Unknown or duplicate request receipt')
    try { const v = nativeUsage(usage); this.used += v.total; if (this.used + this.reserved > this.limit) this.blocked = true; return v }
    catch (e) { this.blocked = true; throw e }
  }
  fail(id) { this.pending.delete(id); this.blocked = true }
}
