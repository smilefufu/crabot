import type { PaneSnapshot } from '../tmux/driver.js'
import type { InputMode, InputProbe } from '../tmux/input-commit.js'
import type { TerminalInteraction } from '../tmux/terminal-interaction.js'
import type { WorkerUiActionDescriptor, WorkerUiControlKey } from '../types.js'

const CLAUDE_FOOTER = /^\s*(?:esc to interrupt|⏵⏵|(?:\?\s*)?for shortcuts|context left|bypass permissions)|(?:auto|manual|plan) mode on\b/i
const CLAUDE_COMPOSER_BOUNDARY = /^\s*(?:[─━-]{3,}|esc to interrupt|⏵⏵|(?:\?\s*)?for shortcuts|context left|bypass permissions)|(?:auto|manual|plan) mode on\b/i

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
    const expectedComposer = claudeComposerText(snapshot, true)
    if (expectedComposer !== undefined && composerMatchesExpected(expectedComposer, text)) return 'pending'
    return composer.length === 0 ? 'empty' : 'unavailable'
  }
  return composer.length === 0 ? 'empty' : 'pending'
}

/** A submit is visually accepted only after the pasted text is no longer in the composer. */
export function acceptedClaudeInput(snapshot: PaneSnapshot, mode: InputMode, text: string): boolean {
  const composer = claudeComposerText(snapshot)
  if (hasClaudeInteraction(snapshot.text) || (composer !== undefined && composerMatchesExpected(composer, text))) return false
  // Steering keeps the active marker and normally renders a queued message.
  return mode === 'primary' ? composer === '' || /esc to interrupt/i.test(snapshot.text) : /queued|queue/i.test(snapshot.text)
}

export function classifyClaudeTerminalInteraction(snapshot: PaneSnapshot): TerminalInteraction {
  const pane = snapshot.text
  // A footer-anchored ordinary composer means a previously rendered selector in
  // the transcript is no longer the active surface.
  if (claudeComposerText(snapshot) !== undefined) return { kind: 'none' }
  const tailLines = pane.split('\n').slice(-24)
  const tail = tailLines.join('\n')
  const exitPlan = /Exit plan mode\?/i.test(tail) &&
    /Claude wants to exit plan mode/i.test(tail) &&
    /^\s*1[.)]\s+\S/m.test(tail) &&
    /^\s*2[.)]\s+\S/m.test(tail)
  if (exitPlan) return { kind: 'automatic', family: 'claude_exit_plan', fingerprint: 'claude_exit_plan:1-2' }
  const readyToCode = /Ready to code\?/i.test(tail) &&
    /Claude has written up a plan and is ready to execute\./i.test(tail) &&
    /Would you like to proceed\?/i.test(tail) &&
    /^\s*(?:❯\s*)?1[.)]\s+Yes, and use auto mode\b/im.test(tail)
  if (readyToCode) return { kind: 'automatic', family: 'claude_exit_plan', fingerprint: 'claude_exit_plan:ready-to-code-auto' }
  const hasOption = tailLines.some((line) => /^\s*(?:❯|[○◉☐☑]|\d+[.)])\s+\S/.test(line))
  const hasYes = /(?:^|\n)\s*(?:❯\s*)?(?:\d+[.)]\s*)?Yes\b/i.test(tail)
  const hasNo = /(?:^|\n)\s*(?:❯\s*)?(?:\d+[.)]\s*)?No\b/i.test(tail)
  const permissionPrompt = /(?:Claude needs your permission|permission required|Do you want to proceed)/i.test(tail)
  const selectionFooter = /(?:Enter to (?:select|confirm)|(?:↑|↓|up|down).*to navigate|use arrow keys to navigate)/i.test(tail)
  if (permissionPrompt && hasYes && hasNo) {
    return managerRequiredInteraction('claude_permission', 'claude_permission:yes-no', tailLines)
  }
  if (selectionFooter && hasOption) {
    return managerRequiredInteraction('claude_selector', 'claude_selector:options', tailLines)
  }
  return { kind: 'none' }
}

/**
 * The two exact exit-plan variants are normally handled by Harness. If that
 * fixed action cannot be verified, Manager receives the same bounded choices
 * as a regular selector, never an arbitrary terminal-input escape hatch.
 */
export function managerActionsForClaudeAutomaticInteraction(snapshot: PaneSnapshot): readonly WorkerUiActionDescriptor[] {
  return boundedUiActions(snapshot.text.split('\n').slice(-24))
}

function managerRequiredInteraction(
  family: string,
  fingerprint: string,
  lines: readonly string[],
): TerminalInteraction {
  return { kind: 'manager_required', family, fingerprint, actions: boundedUiActions(lines) }
}

function boundedUiActions(lines: readonly string[]): WorkerUiActionDescriptor[] {
  const actions: WorkerUiActionDescriptor[] = [
    { action_id: 'confirm', kind: 'keys', keys: ['Enter'] },
    { action_id: 'cancel', kind: 'keys', keys: ['Escape'] },
  ]
  const optionNumbers = new Set<string>()
  for (const line of lines) {
    const option = line.match(/^\s*(?:❯\s*)?([1-9])[.)]\s+\S/)
    if (option) optionNumbers.add(option[1])
  }
  for (const option of optionNumbers) {
    actions.push({ action_id: `select_${option}`, kind: 'keys', keys: [option as WorkerUiControlKey, 'Enter'] })
  }
  return actions
}

/** Notification must be corroborated by a current interaction surface. */
export function hasClaudeInteraction(pane: string): boolean {
  return classifyClaudeTerminalInteraction({ text: pane }).kind !== 'none'
}

export function hasClaudeExecutionOrComposer(snapshot: PaneSnapshot): boolean {
  return claudeComposerText(snapshot) !== undefined || /esc to interrupt/i.test(snapshot.text)
}

function claudeComposerText(snapshot: PaneSnapshot, preservePlaceholderText = false): string | undefined {
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
    return !preservePlaceholderText && /^Try\s+["“].+["”]$/i.test(value) ? '' : value
  }
  return undefined
}

function composerMatchesExpected(composer: string, text: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
  const current = normalize(composer)
  const expected = normalize(text)
  if (expected.length === 0) return false
  if (current.includes(expected)) return true
  if (/\[Pasted text #\d+(?:[^\]]*)\]/i.test(current)) return true
  if (expected.length < 24) return false
  return current.includes(expected.slice(0, 24)) || current.includes(expected.slice(-24))
}
