import { describe, expect, it } from 'vitest'
import { commitInput, type InputProbe } from '../../src/workers/tmux/input-commit.js'
import type { PaneSnapshot } from '../../src/workers/tmux/driver.js'

const snapshot = (text: string): PaneSnapshot => ({ text })

describe('commitInput', () => {
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
