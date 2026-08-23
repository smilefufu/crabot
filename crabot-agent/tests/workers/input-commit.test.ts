import { describe, expect, it } from 'vitest'
import { commitInput, type InputProbe } from '../../src/workers/tmux/input-commit.js'
import type { PaneSnapshot } from '../../src/workers/tmux/driver.js'

const snapshot = (text: string): PaneSnapshot => ({ text })

describe('commitInput', () => {
  it('runs the side-effect guard before paste and every Enter attempt', async () => {
    const phases: string[] = []
    const frames = [snapshot('empty'), snapshot('pending'), snapshot('pending'), snapshot('pending')]
    const result = await commitInput(
      { pasteText: async () => {}, sendEnter: async () => {}, capture: async () => frames.shift()! },
      frame => frame.text as InputProbe,
      () => false,
      'task',
      { settleTimeoutMs: 0, beforeSideEffect: phase => { phases.push(phase) } },
    )

    expect(result.disposition).toBe('pending_in_ui')
    expect(phases).toEqual(['paste', 'enter', 'enter'])
  })

  it('records the settled pane after paste and each submission attempt', async () => {
    const frames = [snapshot('empty'), snapshot('pending'), snapshot('pending'), snapshot('accepted')]
    const diagnostics: Array<{ stage: string; attempt?: number; probe: string; accepted: boolean }> = []
    const result = await commitInput(
      { pasteText: async () => {}, sendEnter: async () => {}, capture: async () => frames.shift()! },
      frame => frame.text as InputProbe,
      frame => frame.text === 'accepted',
      'task',
      {
        settleTimeoutMs: 0,
        onDiagnostic: entry => diagnostics.push({
          stage: entry.stage,
          ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
          probe: entry.probe,
          accepted: entry.accepted,
        }),
      },
    )

    expect(result.disposition).toBe('accepted')
    expect(diagnostics).toEqual([
      { stage: 'before_paste', probe: 'empty', accepted: false },
      { stage: 'after_paste', probe: 'pending', accepted: false },
      { stage: 'after_enter', attempt: 1, probe: 'pending', accepted: false },
      { stage: 'after_enter', attempt: 2, probe: 'accepted', accepted: true },
    ])
  })

  it('a guard failure before Enter never performs that Enter', async () => {
    let pastes = 0
    let enters = 0
    const frames = [snapshot('empty'), snapshot('pending')]

    await expect(commitInput(
      {
        pasteText: async () => { pastes++ },
        sendEnter: async () => { enters++ },
        capture: async () => frames.shift()!,
      },
      frame => frame.text as InputProbe,
      () => false,
      'task',
      {
        settleTimeoutMs: 0,
        beforeSideEffect: phase => {
          if (phase === 'enter') throw new Error('delivery expired after paste')
        },
      },
    )).rejects.toThrow('delivery expired after paste')
    expect(pastes).toBe(1)
    expect(enters).toBe(0)
  })

  it('pastes once and commits once after empty -> pending', async () => {
    const frames = [snapshot('empty'), snapshot('pending'), snapshot('accepted')]
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => frames.shift()! }, frame => frame.text as InputProbe, frame => frame.text === 'accepted', 'task', { settleTimeoutMs: 0 })
    expect(result.disposition).toBe('accepted'); expect(pastes).toBe(1); expect(enters).toBe(1)
  })

  it('waits through a blank startup frame before the composer is drawn', async () => {
    const frames = [snapshot(''), snapshot('empty'), snapshot('pending'), snapshot('accepted')]
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => frames.shift()! }, frame => frame.text === '' ? 'unavailable' : frame.text as InputProbe, frame => frame.text === 'accepted', 'task', { settleTimeoutMs: 50, intervalMs: 0 })
    expect(result.disposition).toBe('accepted'); expect(pastes).toBe(1); expect(enters).toBe(1)
  })

  it('waits through a non-blank transient unavailable frame before pasting', async () => {
    const frames = [snapshot('esc to interrupt'), snapshot('empty'), snapshot('pending'), snapshot('accepted')]
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => frames.shift()! }, frame => frame.text === 'esc to interrupt' ? 'unavailable' : frame.text as InputProbe, frame => frame.text === 'accepted', 'task', { settleTimeoutMs: 50, intervalMs: 0 })
    expect(result.disposition).toBe('accepted'); expect(pastes).toBe(1); expect(enters).toBe(1)
  })

  it('never pastes or enters when primary surface is unavailable', async () => {
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => snapshot('modal') }, () => 'unavailable', () => false, 'task', { settleTimeoutMs: 0 })
    expect(result.disposition).toBe('not_pasted'); expect(pastes).toBe(0); expect(enters).toBe(0)
  })

  it('retries Enter once without re-pasting', async () => {
    const frames = [snapshot('empty'), snapshot('pending'), snapshot('pending'), snapshot('accepted')]
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => frames.shift()! }, frame => frame.text as InputProbe, frame => frame.text === 'accepted', 'task', { settleTimeoutMs: 0 })
    expect(result.disposition).toBe('accepted'); expect(pastes).toBe(1); expect(enters).toBe(2)
  })

  it('reports not_pasted when the composer is still empty after paste', async () => {
    const frames = [snapshot('empty'), snapshot('empty')]
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => frames.shift() ?? snapshot('empty') }, frame => frame.text as InputProbe, () => false, '   ', { settleTimeoutMs: 0 })
    expect(result.disposition).toBe('not_pasted'); expect(pastes).toBe(1); expect(enters).toBe(0)
  })

  it('does not press Enter when the post-paste surface becomes unavailable', async () => {
    const frames = [snapshot('empty'), snapshot('modal')]
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => frames.shift()! }, frame => frame.text as InputProbe, () => false, 'task', { settleTimeoutMs: 0 })
    expect(result.disposition).toBe('pending_in_ui'); expect(pastes).toBe(1); expect(enters).toBe(0)
  })

  it('does not paste again after two Enter attempts remain pending', async () => {
    const frames = [snapshot('empty'), snapshot('pending'), snapshot('pending'), snapshot('pending')]
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => frames.shift()! }, frame => frame.text as InputProbe, () => false, 'task', { settleTimeoutMs: 0 })
    expect(result.disposition).toBe('pending_in_ui'); expect(pastes).toBe(1); expect(enters).toBe(2)
  })
})
