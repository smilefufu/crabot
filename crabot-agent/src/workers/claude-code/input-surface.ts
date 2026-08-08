import type { PaneSnapshot } from '../tmux/driver.js'
import type { InputMode, InputProbe } from '../tmux/input-commit.js'

/**
 * Claude Code viewport recognizer for one guarded input transaction.
 * It deliberately answers only whether the expected input surface is safe; it
 * does not infer turn completion from a composer being visible.
 */
export function probeClaudeInput(snapshot: PaneSnapshot, mode: InputMode, text?: string): InputProbe {
  const pane = snapshot.text
  if (hasClaudeInteraction(pane) || !hasClaudeComposer(pane)) return 'unavailable'
  const active = /esc to interrupt/i.test(pane)
  if ((mode === 'steering') !== active) return 'unavailable'
  if (text !== undefined && pane.includes(text)) return 'pending'
  return 'empty'
}

/** A submit is visually accepted only after the pasted text is no longer in the composer. */
export function acceptedClaudeInput(snapshot: PaneSnapshot, mode: InputMode, text: string): boolean {
  if (hasClaudeInteraction(snapshot.text) || snapshot.text.includes(text)) return false
  // Steering keeps the active marker and normally renders a queued message.
  return mode === 'primary' ? hasClaudeComposer(snapshot.text) || /esc to interrupt/i.test(snapshot.text) : /queued|queue/i.test(snapshot.text)
}

/** Notification must be corroborated by a current interaction surface. */
export function hasClaudeInteraction(pane: string): boolean {
  return /(?:AskUserQuestion|Claude needs your permission|permission required|\b(?:yes|no),?\s*(?:I accept|exit)\b|select an option|use arrow keys)/i.test(pane)
}

function hasClaudeComposer(pane: string): boolean {
  return /(?:^|\n)\s*❯(?:\s|$)/m.test(pane)
}
