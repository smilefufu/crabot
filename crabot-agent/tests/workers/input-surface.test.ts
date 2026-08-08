import { describe, expect, it } from 'vitest'
import { acceptedClaudeInput, hasClaudeInteraction, probeClaudeInput } from '../../src/workers/claude-code/input-surface.js'
import { acceptedCodexInput, probeCodexInput } from '../../src/workers/codex/input-surface.js'
import type { PaneSnapshot } from '../../src/workers/tmux/driver.js'

const pane = (text: string): PaneSnapshot => ({ text, cursor_x: 0, cursor_y: 0, width: 100, height: 30 })

describe('CLI input surfaces', () => {
  it('does not treat a Claude running composer as primary input', () => {
    const running = pane('working\n❯ \nesc to interrupt')
    expect(probeClaudeInput(running, 'primary')).toBe('unavailable')
    expect(probeClaudeInput(running, 'steering')).toBe('empty')
  })

  it('recognizes Claude pending text without changing control state', () => {
    const pending = pane('working\n❯ 请继续\nesc to interrupt')
    expect(probeClaudeInput(pending, 'steering', '请继续')).toBe('pending')
    expect(acceptedClaudeInput(pending, 'steering', '请继续')).toBe(false)
  })

  it('requires a current Claude interaction surface', () => {
    expect(hasClaudeInteraction('Claude needs your permission\n1. Yes\n2. No')).toBe(true)
    expect(probeClaudeInput(pane('Claude needs your permission\n❯ '), 'primary')).toBe('unavailable')
  })

  it('scopes Claude pending evidence to the active composer, not transcript history', () => {
    const text = 'repeat this task'
    const historyOnly = pane(`assistant history: ${text}\n❯ \n? for shortcuts`)
    expect(probeClaudeInput(historyOnly, 'primary', text)).toBe('empty')
    expect(probeClaudeInput(pane('❯\u00a0Try "how does <filepath> work?"\n────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)'), 'primary')).toBe('empty')
    expect(acceptedClaudeInput(historyOnly, 'primary', text)).toBe(true)
    const selector = pane('transcript\n❯ historical choice\n────────────────\n⏵⏵ bypass permissions on')
    expect(probeClaudeInput(selector, 'primary', 'new')).toBe('unavailable')
    expect(acceptedClaudeInput(selector, 'primary', 'new')).toBe(false)

    const multiline = pane(`history\n❯ first line\nsecond line\n? for shortcuts`)
    expect(probeClaudeInput(multiline, 'primary', 'first line\nsecond line')).toBe('pending')
  })

  it('keeps Codex Working composer in steering mode', () => {
    const working = pane('› \nWorking (esc to interrupt)')
    expect(probeCodexInput(working, 'primary')).toBe('unavailable')
    expect(probeCodexInput(working, 'steering')).toBe('empty')
  })

  it('scopes Codex pending evidence to the active composer, not transcript history', () => {
    const text = 'repeat this task'
    const historyOnly = pane(`user history: ${text}\n› \n? for shortcuts`)
    expect(probeCodexInput(historyOnly, 'primary', text)).toBe('empty')
    expect(probeCodexInput(pane('› Find and fix a bug in @filename\n  gpt-5.6-sol xhigh · /private/tmp/workspace'), 'primary')).toBe('empty')
    expect(acceptedCodexInput(historyOnly, 'primary', text, historyOnly.text)).toBe(true)
    const selector = pane('history\n› historical choice\n  gpt-5.6-sol xhigh · /private/tmp/workspace')
    expect(probeCodexInput(selector, 'primary', 'new')).toBe('unavailable')
    expect(acceptedCodexInput(selector, 'primary', 'new', selector.text)).toBe(false)

    const multiline = pane(`history\n› first line\nsecond line\n? for shortcuts`)
    expect(probeCodexInput(multiline, 'primary', 'first line\nsecond line')).toBe('pending')
  })

  it('does not accept an old Codex queued region as this delivery', () => {
    const old = 'Messages to be submitted after next tool call\n› \nWorking (esc to interrupt)'
    expect(acceptedCodexInput(pane(old), 'steering', 'new text', old)).toBe(false)
    const next = `${old}\nMessages to be submitted after next tool call`
    expect(acceptedCodexInput(pane(next), 'steering', 'new text', old)).toBe(true)
  })
})
