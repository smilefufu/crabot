import { describe, expect, it } from 'vitest'
import { classifyClaudeTerminalInteraction, probeClaudeInput } from '../../src/workers/claude-code/input-surface.js'
import { classifyCodexTerminalInteraction } from '../../src/workers/codex/input-surface.js'

describe('current terminal interaction classification', () => {
  it('classifies the footer-less Claude exit-plan modal as the sole automatic action', () => {
    expect(classifyClaudeTerminalInteraction({
      text: [
        'Exit plan mode?',
        'Claude wants to exit plan mode',
        '1. Yes, and switch to default (ask each time) for this session',
        '2. No',
      ].join('\n'),
    })).toEqual({ kind: 'automatic', family: 'claude_exit_plan', fingerprint: 'claude_exit_plan:1-2' })
  })

  it('classifies the current Claude ready-to-code auto confirmation as the same fixed action', () => {
    expect(classifyClaudeTerminalInteraction({
      text: [
        'Ready to code?',
        "Here is Claude's plan:",
        'Plan: Create hello.txt containing hello',
        'Claude has written up a plan and is ready to execute. Would you like to proceed?',
      '❯ 1. Yes, and use auto mode',
      '  2. Yes, manually approve edits',
      '  3. Tell Claude what to change',
      '    shift+tab to approve with this feedback',
      '⏸ plan mode on (shift+tab to cycle)',
      'ctrl+g to edit in Vim',
      '~/.claude/plans/create-a-minimal-plan.md',
    ].join('\n'),
  })).toEqual({ kind: 'automatic', family: 'claude_exit_plan', fingerprint: 'claude_exit_plan:ready-to-code-auto' })
  })

  it('does not treat a historical Claude modal above the current composer as active', () => {
    expect(classifyClaudeTerminalInteraction({
      text: [
        'Exit plan mode?',
        'Claude wants to exit plan mode',
        '1. Yes, and switch to default (ask each time) for this session',
        '2. No',
        '',
        '❯ ',
        '? for shortcuts',
      ].join('\n'),
    })).toEqual({ kind: 'none' })
  })

  it('keeps a Claude mode footer as an empty ordinary composer', () => {
    expect(probeClaudeInput({
      text: [
        '❯ ',
        '⏸ manual mode on (shift+tab to cycle)',
      ].join('\n'),
    }, 'primary')).toBe('empty')
  })

  it('classifies the visible Claude plan confirmation when its heading is above the viewport', () => {
    expect(classifyClaudeTerminalInteraction({
      text: [
        'Claude has written up a plan and is ready to execute. Would you like to',
        'proceed?',
        '❯ 1. Yes, and use auto mode',
        '  2. Yes, manually approve edits',
        '  3. Tell Claude what to change',
        '    shift+tab to approve with this feedback',
        'ctrl+g to edit in Vim ·',
        '~/.claude/plans/create-a-plan.md',
      ].join('\n'),
    })).toEqual({ kind: 'automatic', family: 'claude_exit_plan', fingerprint: 'claude_exit_plan:ready-to-code-auto' })
  })

  it('keeps a current Claude permission dialog manager-owned', () => {
    expect(classifyClaudeTerminalInteraction({
      text: [
        'Claude needs your permission',
        '1. Yes',
        '2. No',
      ].join('\n'),
    })).toEqual({
      kind: 'manager_required',
      family: 'claude_permission',
      fingerprint: 'claude_permission:yes-no',
      actions: [
        { action_id: 'confirm', kind: 'keys', keys: ['Enter'] },
        { action_id: 'cancel', kind: 'keys', keys: ['Escape'] },
        { action_id: 'select_1', kind: 'keys', keys: ['1', 'Enter'] },
        { action_id: 'select_2', kind: 'keys', keys: ['2', 'Enter'] },
      ],
    })
  })

  it('does not treat a historical Codex approval above the current composer as active', () => {
    expect(classifyCodexTerminalInteraction({
      text: [
        'Allow Codex to modify this workspace?',
        'Yes',
        'No',
        '',
        '› ',
        'gpt-5.6-sol xhigh · ~/.crabot/data',
      ].join('\n'),
    })).toEqual({ kind: 'none' })
  })

  it('keeps a current Codex approval dialog manager-owned', () => {
    expect(classifyCodexTerminalInteraction({
      text: [
        'Allow Codex to modify this workspace?',
        'Yes',
        'No',
      ].join('\n'),
    })).toEqual({
      kind: 'manager_required',
      family: 'codex_approval',
      fingerprint: 'codex_approval:yes-no',
      actions: [
        { action_id: 'confirm', kind: 'keys', keys: ['Enter'] },
        { action_id: 'cancel', kind: 'keys', keys: ['Escape'] },
      ],
    })
  })
})
