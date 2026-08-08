import type { PaneSnapshot } from '../tmux/driver.js'
import type { InputMode, InputProbe } from '../tmux/input-commit.js'

const CODEX_FOOTER = /^\s*(?:Working\b|esc to interrupt|(?:\?\s*)?for shortcuts|\d+% context|context left|.*\s·\s\/)/i
const CODEX_COMPOSER_BOUNDARY = /^\s*(?:[─━-]{3,}|Working\b|esc to interrupt|(?:\?\s*)?for shortcuts|\d+% context|context left|.*\s·\s\/)/i
const CODEX_PLACEHOLDERS = [
  'Explain this codebase',
  'Summarize recent commits',
  'Implement {feature}',
  'Find and fix a bug in @filename',
  'Write tests for @filename',
  'Improve documentation in @filename',
  'Run /review on my current changes',
  'Use /skills to list available skills',
  'Check recently modified functions for compatibility',
  'How many files have been modified?',
  'Will this algorithm scale well?',
]

/** Codex-specific viewport recognizer. It has no interaction-notify equivalent. */
export function probeCodexInput(snapshot: PaneSnapshot, mode: InputMode, text?: string, enforceMode = true): InputProbe {
  const pane = snapshot.text
  if (hasCodexInteraction(pane)) return 'unavailable'
  const composer = codexComposerText(snapshot)
  if (composer === undefined) return 'unavailable'
  const working = /Working\b.*(?:esc to interrupt)?/i.test(pane)
  if (enforceMode && (mode === 'steering') !== working) return 'unavailable'
  if (text !== undefined) {
    if (composerContains(composer, text)) return 'pending'
    return composer.length === 0 ? 'empty' : 'unavailable'
  }
  return composer.length === 0 ? 'empty' : 'pending'
}

/** Codex steering receipt is visual only: a newly rendered queue region. */
export function acceptedCodexInput(snapshot: PaneSnapshot, mode: InputMode, text: string, baseline: string): boolean {
  const composer = codexComposerText(snapshot)
  if (hasCodexInteraction(snapshot.text) || (composer !== undefined && composerContains(composer, text))) return false
  if (mode === 'primary') return composer === '' || /Working\b/i.test(snapshot.text)
  return snapshot.text !== baseline && /Messages to be submitted after next tool call|queued message|queued/i.test(snapshot.text)
}

function hasCodexInteraction(pane: string): boolean {
  return /(?:approve|deny|permission|required selection|select an option|use arrow keys)/i.test(pane)
}

function codexComposerText(snapshot: PaneSnapshot): string | undefined {
  const lines = snapshot.text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^\s*›(?:\s?(.*))?$/)
    if (!match) continue
    const anchored = lines.slice(i + 1).some((line) => CODEX_FOOTER.test(line))
    if (!anchored) return undefined
    const content = [match[1] ?? '']
    for (let j = i + 1; j < lines.length; j++) {
      if (CODEX_COMPOSER_BOUNDARY.test(lines[j])) break
      content.push(lines[j])
    }
    const value = content.join('\n').trim()
    return isCodexPlaceholder(value) ? '' : value
  }
  return undefined
}

function isCodexPlaceholder(value: string): boolean {
  return CODEX_PLACEHOLDERS.some((placeholder) => value.startsWith(placeholder))
}

function composerContains(composer: string, text: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
  const expected = normalize(text)
  return expected.length > 0 && normalize(composer).includes(expected)
}
