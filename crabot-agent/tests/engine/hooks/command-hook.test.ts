import { describe, it, expect } from 'vitest'
import { executeCommandHook } from '../../../src/hooks/command-hook'
import type { HookDefinition, HookInput } from '../../../src/hooks/types'

const baseInput: HookInput = {
  event: 'PostToolUse',
  toolName: 'Write',
  toolInput: { file_path: '/tmp/test.ts', content: 'const x = 1' },
  workingDirectory: '/tmp',
}

describe('executeCommandHook', () => {
  it('exit 0 returns continue with stdout as message', async () => {
    const hook: HookDefinition = { event: 'PostToolUse', type: 'command', command: 'echo "all good"' }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })
    expect(result.action).toBe('continue')
    expect(result.message).toContain('all good')
  })

  it('exit 2 returns block with stderr as message', async () => {
    const hook: HookDefinition = { event: 'PostToolUse', type: 'command', command: 'echo "error found" >&2; exit 2' }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })
    expect(result.action).toBe('block')
    expect(result.message).toContain('error found')
  })

  it('other exit codes return continue with stderr as message', async () => {
    const hook: HookDefinition = { event: 'PostToolUse', type: 'command', command: 'echo "warning" >&2; exit 1' }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })
    expect(result.action).toBe('continue')
    expect(result.message).toContain('warning')
  })

  it('parses JSON stdout with action/message fields', async () => {
    const hook: HookDefinition = {
      event: 'PostToolUse', type: 'command',
      command: `echo '{"action":"block","message":"type error on line 5"}'`,
    }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })
    expect(result.action).toBe('block')
    expect(result.message).toBe('type error on line 5')
  })

  it('respects timeout and returns continue on timeout', async () => {
    const hook: HookDefinition = { event: 'PostToolUse', type: 'command', command: 'sleep 10', timeout: 1 }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })
    expect(result.action).toBe('continue')
    expect(result.message).toContain('timeout')
  }, 5000)

  it('routes __internal: prefix to internal handler', async () => {
    const hook: HookDefinition = {
      event: 'PostToolUse', type: 'command',
      command: '__internal:lsp-diagnostics',
    }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })
    expect(result.action).toBe('continue')
  })

  it('returns continue when command is undefined', async () => {
    const hook: HookDefinition = { event: 'PostToolUse', type: 'command' }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })
    expect(result.action).toBe('continue')
  })
})
