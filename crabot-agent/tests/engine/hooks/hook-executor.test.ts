import { describe, it, expect } from 'vitest'
import { executeHooks } from '../../../src/hooks/hook-executor'
import type { HookDefinition, HookInput, HookExecutorContext } from '../../../src/hooks/types'

const baseInput: HookInput = { event: 'PostToolUse', toolName: 'Write', workingDirectory: '/tmp' }
const baseContext: HookExecutorContext = { workingDirectory: '/tmp' }

describe('executeHooks', () => {
  it('returns continue with no message when no hooks', async () => {
    const result = await executeHooks([], baseInput, baseContext)
    expect(result.action).toBe('continue')
    expect(result.message).toBeUndefined()
  })

  it('merges multiple continue results', async () => {
    const hooks: HookDefinition[] = [
      { event: 'PostToolUse', type: 'command', command: 'echo "check 1 ok"' },
      { event: 'PostToolUse', type: 'command', command: 'echo "check 2 ok"' },
    ]
    const result = await executeHooks(hooks, baseInput, baseContext)
    expect(result.action).toBe('continue')
    expect(result.message).toContain('check 1 ok')
    expect(result.message).toContain('check 2 ok')
  })

  it('any block makes final result block', async () => {
    const hooks: HookDefinition[] = [
      { event: 'PostToolUse', type: 'command', command: 'echo "ok"' },
      { event: 'PostToolUse', type: 'command', command: 'echo "error" >&2; exit 2' },
    ]
    const result = await executeHooks(hooks, baseInput, baseContext)
    expect(result.action).toBe('block')
  })

  it('concatenates messages with separator', async () => {
    const hooks: HookDefinition[] = [
      { event: 'PostToolUse', type: 'command', command: 'echo "msg1"' },
      { event: 'PostToolUse', type: 'command', command: 'echo "msg2"' },
    ]
    const result = await executeHooks(hooks, baseInput, baseContext)
    expect(result.message).toContain('msg1')
    expect(result.message).toContain('msg2')
    expect(result.message).toContain('---')
  })
})
