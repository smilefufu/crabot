import { describe, expect, it } from 'vitest'
import { hasDimComposerEvidence } from '../../src/workers/tmux/ansi.js'

describe('hasDimComposerEvidence', () => {
  it('matches styled cells rather than UTF-16 string offsets', () => {
    expect(hasDimComposerEvidence({
      styled_text: `🙂 › \u001b[2mAsk Codex to do anything\u001b[0m`,
    }, '›', 'Ask Codex to do anything')).toBe(true)
  })
})
