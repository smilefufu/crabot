import { describe, expect, it } from 'vitest'
import { InvalidRawControlInputError, parseRawControlKeys } from '../../../src/workers/tmux/raw-control.js'

describe('parseRawControlKeys', () => {
  it('accepts individual tmux control keys', () => {
    expect(parseRawControlKeys('y Enter C-c \u0003')).toEqual(['y', 'Enter', 'C-c', '\u0003'])
  })

  it('rejects conversation text before it can reach a pane', () => {
    expect(() => parseRawControlKeys('y208地形已完成')).toThrow(InvalidRawControlInputError)
    expect(() => parseRawControlKeys('好')).toThrow(InvalidRawControlInputError)
  })
})
