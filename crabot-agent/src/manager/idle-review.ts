import type { EngineToolLifecycleEvent } from '../engine/types.js'
import type { ManagerWorkboard, WorkboardObjective } from './workboard-store.js'
import { reviewFingerprint } from '../workers/harness/idle-review-facts.js'

function content(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(content)
    if (items.every(item => item && typeof item === 'object' && ('objective_id' in item || 'work_item_id' in item))) {
      items.sort((left, right) => {
        const a = left as Record<string, string>
        const b = right as Record<string, string>
        return (a.work_item_id ?? a.objective_id).localeCompare(b.work_item_id ?? b.objective_id)
      })
    }
    return items
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'updated_at').map(([key, item]) => [key, content(item)]))
  return value
}

export function boardReviewFingerprint(board: ManagerWorkboard): string {
  return reviewFingerprint(content(board))
}

/** Qualification comes from actual tool results, not a completed episode or a preflight read. */
export class IdleReviewRead {
  private readonly read = new Map<string, string>()
  private readonly expected: Map<string, string>
  private invalid = false

  constructor(board: ManagerWorkboard) {
    this.expected = new Map(board.objectives.map(item => [item.objective_id, reviewFingerprint(content(item))]))
  }

  record(event: Extract<EngineToolLifecycleEvent, { type: 'tool_finished' }>, readOnly: boolean): void {
    if (event.isError || !readOnly) this.invalid = true
    if (event.isError || event.name !== 'inspect_workboard' || event.input.query !== undefined
      || (event.input.view !== undefined && event.input.view !== 'active')) return
    try {
      const result = JSON.parse(event.output.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '')) as { view: string; objectives: WorkboardObjective[] }
      if (result.view !== 'active' || !Array.isArray(result.objectives)) return
      for (const item of result.objectives) this.read.set(item.objective_id, reviewFingerprint(content(item)))
    } catch { this.invalid = true }
  }

  get complete(): boolean {
    return !this.invalid && this.expected.size > 0 && this.expected.size === this.read.size
      && [...this.expected].every(([id, fingerprint]) => this.read.get(id) === fingerprint)
  }
}
