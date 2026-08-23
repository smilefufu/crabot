import { describe, expect, it } from 'vitest'
import { acceptedClaudeInput, hasClaudeInteraction, probeClaudeInput } from '../../src/workers/claude-code/input-surface.js'
import { acceptedCodexInput, probeCodexInput } from '../../src/workers/codex/input-surface.js'
import type { PaneSnapshot } from '../../src/workers/tmux/driver.js'

const pane = (text: string): PaneSnapshot => ({ text })

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
    expect(hasClaudeInteraction('Choose files\n☐ package.json\nEnter to select · ↑/↓ to navigate')).toBe(true)
    expect(hasClaudeInteraction('Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept\nEnter to confirm · Esc to cancel')).toBe(true)
  })

  it('does not let Claude transcript keywords or old selectors impersonate interaction UI', () => {
    const idle = pane('tool docs mention AskUserQuestion and use arrow keys\nfinished with no exit code\n❯ \n? for shortcuts')
    expect(hasClaudeInteraction(idle.text)).toBe(false)
    expect(probeClaudeInput(idle, 'primary')).toBe('empty')

    const oldSelector = pane('old question\n❯ 1. Alpha\n  2. Beta\nEnter to select · ↑/↓ to navigate\nanswer recorded\n❯ \n? for shortcuts')
    expect(hasClaudeInteraction(oldSelector.text)).toBe(false)
    expect(probeClaudeInput(oldSelector, 'primary')).toBe('empty')
  })

  it('scopes Claude pending evidence to the active composer, not transcript history', () => {
    const text = 'repeat this task'
    const historyOnly = pane(`assistant history: ${text}\n❯ \n? for shortcuts`)
    expect(probeClaudeInput(historyOnly, 'primary', text)).toBe('empty')
    const claudePlaceholder = 'Try "how does <filepath> work?"'
    const claudePlaceholderPane = pane(`❯\u00a0${claudePlaceholder}\n────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`)
    expect(probeClaudeInput(claudePlaceholderPane, 'primary')).toBe('empty')
    expect(probeClaudeInput(claudePlaceholderPane, 'primary', claudePlaceholder)).toBe('pending')
    expect(probeClaudeInput(claudePlaceholderPane, 'primary', 'a different task')).toBe('empty')
    expect(acceptedClaudeInput(historyOnly, 'primary', text)).toBe(true)
    const selector = pane('transcript\n❯ historical choice\n────────────────\n⏵⏵ bypass permissions on')
    expect(probeClaudeInput(selector, 'primary', 'new')).toBe('unavailable')
    expect(acceptedClaudeInput(selector, 'primary', 'new')).toBe(false)

    const multiline = pane(`history\n❯ first line\nsecond line\n? for shortcuts`)
    expect(probeClaudeInput(multiline, 'primary', 'first line\nsecond line')).toBe('pending')
    expect(probeClaudeInput(pane('❯ [Pasted text #1 +37 lines]\n? for shortcuts'), 'primary', 'very long prompt\n'.repeat(40))).toBe('pending')
    expect(probeClaudeInput(pane('❯ ending-abcdefghijklmnopqrstuvwx\n? for shortcuts'), 'primary', `beginning-${'x'.repeat(200)}ending-abcdefghijklmnopqrstuvwx`)).toBe('pending')
  })

  it('recognizes a real long Claude paste when the viewport clips its beginning and inserts wrap padding', () => {
    const prompt = '在当前 Minecraft 工作区和服务器环境中完成用户要求：安装 JEI 到 Java 26.2 + Fabric 生产服。先核对工作区/生产服结构、当前 Minecraft 版本、Fabric Loader/API 与 JEI 的兼容版本及依赖；确认 JEI 应安装客户端、服务端还是两端，并避免把不兼容的 NeoForge/Forge 文件放入 Fabric。执行前做好必要的停服一致备份或可回滚措施；严格保护权威世界 java/data，不重建世界，不执行无关迁移修复。若必须重启，先安全停服、安装、启动并检查日志/进程/端口/健康状态；如下载、版本或权限无法确认，安全阻断并报告原因，不绕过门禁。最终报告实际文件名、版本、依赖、安装路径、备份/回滚信息、服务状态和客户端还需做什么。不要只给建议，要实际操作；但任何不确定或可能破坏生产的步骤先停下并汇报。'
    const viewport = pane([
      ' ▐▛███▛█   Claude Code v2.1.241',
      '  ▝▝ ▝▝    ~/codes/playground/minecraft',
      '❯\u00a0应安装客户端、服务端还是两端，并避免把不兼容的 NeoForge/Forge 文件放入',
      '  Fabric。执行前做好必要的停服一致备份或可回滚措施；严格保护权威世界',
      '  java/data，不重建世界，不执行无关迁移修复。若必须重启，先安全停服、安装、启',
      '  动并检查日志/进程/端口/健康状态；如下载、版本或权限无法确认，安全阻断并报告',
      '  原因，不绕过门禁。最终报告实际文件名、版本、依赖、安装路径、备份/回滚信息、 ',
      '  服务状态和客户端还需做什么。不要只给建议，要实际操作；但任何不确定或可能破坏  ',
      '  生产的步骤先停下并汇报。 ',
      '────────────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n'))
    expect(probeClaudeInput(viewport, 'primary', prompt)).toBe('pending')
  })

  it('keeps Codex Working composer in steering mode', () => {
    const working = pane('› \nWorking (esc to interrupt)')
    expect(probeCodexInput(working, 'primary')).toBe('unavailable')
    expect(probeCodexInput(working, 'steering')).toBe('empty')
  })

  it('does not let Codex transcript keywords impersonate active/modal UI', () => {
    const idle = pane('Permission denied while reading a file\nWorking notes from history\n› \n? for shortcuts')
    expect(probeCodexInput(idle, 'primary')).toBe('empty')
    expect(probeCodexInput(idle, 'steering')).toBe('unavailable')
  })

  it('scopes Codex pending evidence to the active composer, not transcript history', () => {
    const text = 'repeat this task'
    const historyOnly = pane(`user history: ${text}\n› \n? for shortcuts`)
    expect(probeCodexInput(historyOnly, 'primary', text)).toBe('empty')
    expect(probeCodexInput(pane('› Find and fix a bug in @filename\n  gpt-5.6-sol xhigh · /private/tmp/workspace'), 'primary')).toBe('empty')
    const exactPlaceholder = 'Explain this codebase'
    expect(probeCodexInput(
      pane(`› ${exactPlaceholder}\n  gpt-5.6-sol xhigh · /private/tmp/workspace`),
      'primary',
      exactPlaceholder,
    )).toBe('pending')
    expect(probeCodexInput(
      pane(`› ${exactPlaceholder}\n  gpt-5.6-sol xhigh · /private/tmp/workspace`),
      'primary',
      'a different task',
    )).toBe('empty')
    const placeholderPrefix = 'Explain this codebase and list the module boundaries'
    expect(probeCodexInput(
      pane(`› ${placeholderPrefix}\n  gpt-5.6-sol xhigh · /private/tmp/workspace`),
      'primary',
      placeholderPrefix,
    )).toBe('pending')
    expect(acceptedCodexInput(historyOnly, 'primary', text, historyOnly.text)).toBe(true)
    const selector = pane('history\n› historical choice\n  gpt-5.6-sol xhigh · /private/tmp/workspace')
    expect(probeCodexInput(selector, 'primary', 'new')).toBe('unavailable')
    expect(acceptedCodexInput(selector, 'primary', 'new', selector.text)).toBe(false)

    const multiline = pane(`history\n› first line\nsecond line\n? for shortcuts`)
    expect(probeCodexInput(multiline, 'primary', 'first line\nsecond line')).toBe('pending')
    expect(probeCodexInput(pane('› [Pasted Content: 2048 chars]\n? for shortcuts'), 'primary', 'long codex prompt\n'.repeat(80))).toBe('pending')
  })

  it('does not accept an old Codex queued region as this delivery', () => {
    const old = 'Messages to be submitted after next tool call\n› \nWorking (esc to interrupt)'
    expect(acceptedCodexInput(pane(old), 'steering', 'new text', old)).toBe(false)
    const next = `${old}\nMessages to be submitted after next tool call`
    expect(acceptedCodexInput(pane(next), 'steering', 'new text', old)).toBe(true)
  })
})
