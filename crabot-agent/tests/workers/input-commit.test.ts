import { describe, expect, it } from 'vitest'
import { commitInput, type InputProbe } from '../../src/workers/tmux/input-commit.js'
import type { PaneSnapshot } from '../../src/workers/tmux/driver.js'

const snapshot = (text: string): PaneSnapshot => ({ text, cursor_x: 0, cursor_y: 0, width: 80, height: 24 })

describe('commitInput', () => {
  it('pastes once and commits once after empty -> pending', async () => {
    const frames = [snapshot('empty'), snapshot('pending'), snapshot('accepted')]
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => frames.shift()! }, frame => frame.text as InputProbe, frame => frame.text === 'accepted', 'task')
    expect(result.disposition).toBe('accepted'); expect(pastes).toBe(1); expect(enters).toBe(1)
  })

  it('never pastes or enters when primary surface is unavailable', async () => {
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => snapshot('modal') }, () => 'unavailable', () => false, 'task')
    expect(result.disposition).toBe('not_pasted'); expect(pastes).toBe(0); expect(enters).toBe(0)
  })

  it('retries Enter once without re-pasting', async () => {
    const frames = [snapshot('empty'), snapshot('pending'), snapshot('pending'), snapshot('accepted')]
    let pastes = 0; let enters = 0
    const result = await commitInput({ pasteText: async () => { pastes++ }, sendEnter: async () => { enters++ }, capture: async () => frames.shift()! }, frame => frame.text as InputProbe, frame => frame.text === 'accepted', 'task')
    expect(result.disposition).toBe('accepted'); expect(pastes).toBe(1); expect(enters).toBe(2)
  })
})
