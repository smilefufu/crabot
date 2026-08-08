import type { PaneSnapshot } from '../tmux/driver.js'
import type { InputMode, InputProbe } from '../tmux/input-commit.js'

const CLAUDE_FOOTER = /^\s*(?:esc to interrupt|⏵⏵|(?:\?\s*)?for shortcuts|context left|bypass permissions|.*shift\+tab)/i
const CLAUDE_COMPOSER_BOUNDARY = /^\s*(?:[─━-]{3,}|esc to interrupt|⏵⏵|(?:\?\s*)?for shortcuts|context left|bypass permissions)/i

/**
 * Claude Code viewport recognizer for one guarded input transaction.
 * It deliberately answers only whether the expected input surface is safe; it
 * does not infer turn completion from a composer being visible.
 */
export function probeClaudeInput(snapshot: PaneSnapshot, mode: InputMode, text?: string, enforceMode = true): InputProbe {
  const pane = snapshot.text
  if (hasClaudeInteraction(pane)) return 'unavailable'
  const composer = claudeComposerText(snapshot)
  if (composer === undefined) return 'unavailable'
  const active = /esc to interrupt/i.test(pane)
  if (enforceMode && (mode === 'steering') !== active) return 'unavailable'
  if (text !== undefined) {
    if (composerContains(composer, text)) return 'pending'
    return composer.length === 0 ? 'empty' : 'unavailable'
  }
  return composer.length === 0 ? 'empty' : 'pending'
}

/** A submit is visually accepted only after the pasted text is no longer in the composer. */
export function acceptedClaudeInput(snapshot: PaneSnapshot, mode: InputMode, text: string): boolean {
  const composer = claudeComposerText(snapshot)
  if (hasClaudeInteraction(snapshot.text) || (composer !== undefined && composerContains(composer, text))) return false
  // Steering keeps the active marker and normally renders a queued message.
  return mode === 'primary' ? composer === '' || /esc to interrupt/i.test(snapshot.text) : /queued|queue/i.test(snapshot.text)
}

/** Notification must be corroborated by a current interaction surface. */
export function hasClaudeInteraction(pane: string): boolean {
  return /(?:AskUserQuestion|Claude needs your permission|permission required|\b(?:yes|no),?\s*(?:I accept|exit)\b|select an option|use arrow keys)/i.test(pane)
}

function claudeComposerText(snapshot: PaneSnapshot): string | undefined {
  const lines = snapshot.text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^\s*❯(?:\s?(.*))?$/)
    if (!match) continue
    const anchored = lines.slice(i + 1).some((line) => CLAUDE_FOOTER.test(line))
    if (!anchored) return undefined
    const content = [match[1] ?? '']
    for (let j = i + 1; j < lines.length; j++) {
      if (CLAUDE_COMPOSER_BOUNDARY.test(lines[j])) break
      content.push(lines[j])
    }
    const value = content.join('\n').trim()
    return /^Try\s+["“].+["”]$/i.test(value) ? '' : value
  }
  return undefined
}

function composerContains(composer: string, text: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
  const expected = normalize(text)
  return expected.length > 0 && normalize(composer).includes(expected)
}
