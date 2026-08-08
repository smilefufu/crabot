import { describe, expect, it } from 'vitest'
import { acceptedClaudeInput, hasClaudeInteraction, probeClaudeInput } from '../../src/workers/claude-code/input-surface.js'
import { acceptedCodexInput, probeCodexInput } from '../../src/workers/codex/input-surface.js'
import type { PaneSnapshot } from '../../src/workers/tmux/driver.js'

const pane = (text: string): PaneSnapshot => ({ text, cursor_x: 0, cursor_y: 0, width: 100, height: 30 })

describe('CLI input surfaces', () => {
  it('does not treat a Claude running composer as primary input', () => {
    const running = pane('working\nesc to interrupt\n❯ ')
    expect(probeClaudeInput(running, 'primary')).toBe('unavailable')
    expect(probeClaudeInput(running, 'steering')).toBe('empty')
  })

  it('recognizes Claude pending text without changing control state', () => {
    const pending = pane('working\nesc to interrupt\n❯ 请继续')
    expect(probeClaudeInput(pending, 'steering', '请继续')).toBe('pending')
    expect(acceptedClaudeInput(pending, 'steering', '请继续')).toBe(false)
  })

  it('requires a current Claude interaction surface', () => {
    expect(hasClaudeInteraction('Claude needs your permission\n1. Yes\n2. No')).toBe(true)
    expect(probeClaudeInput(pane('Claude needs your permission\n❯ '), 'primary')).toBe('unavailable')
  })

  it('keeps Codex Working composer in steering mode', () => {
    const working = pane('Working (esc to interrupt)\n› ')
    expect(probeCodexInput(working, 'primary')).toBe('unavailable')
    expect(probeCodexInput(working, 'steering')).toBe('empty')
  })

  it('does not accept an old Codex queued region as this delivery', () => {
    const old = 'Working (esc to interrupt)\nMessages to be submitted after next tool call\n› '
    expect(acceptedCodexInput(pane(old), 'steering', 'new text', old)).toBe(false)
    const next = `${old}\nMessages to be submitted after next tool call`
    expect(acceptedCodexInput(pane(next), 'steering', 'new text', old)).toBe(true)
  })
})
