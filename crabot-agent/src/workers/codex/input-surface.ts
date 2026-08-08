import type { PaneSnapshot } from '../tmux/driver.js'
import type { InputMode, InputProbe } from '../tmux/input-commit.js'

/** Codex-specific viewport recognizer. It has no interaction-notify equivalent. */
export function probeCodexInput(snapshot: PaneSnapshot, mode: InputMode, text?: string): InputProbe {
  const pane = snapshot.text
  if (hasCodexInteraction(pane) || !hasCodexComposer(pane)) return 'unavailable'
  const working = /Working\b.*(?:esc to interrupt)?/i.test(pane)
  if ((mode === 'steering') !== working) return 'unavailable'
  if (text !== undefined && pane.includes(text)) return 'pending'
  return 'empty'
}

/** Codex steering receipt is visual only: a newly rendered queue region. */
export function acceptedCodexInput(snapshot: PaneSnapshot, mode: InputMode, text: string, baseline: string): boolean {
  if (hasCodexInteraction(snapshot.text) || snapshot.text.includes(text)) return false
  if (mode === 'primary') return hasCodexComposer(snapshot.text) || /Working\b/i.test(snapshot.text)
  return snapshot.text !== baseline && /Messages to be submitted after next tool call|queued message|queued/i.test(snapshot.text)
}

function hasCodexInteraction(pane: string): boolean {
  return /(?:approve|deny|permission|required selection|select an option|use arrow keys)/i.test(pane)
}

function hasCodexComposer(pane: string): boolean {
  return /(?:^|\n)\s*›(?:\s|$)/m.test(pane)
}
