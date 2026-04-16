import { describe, it, expect } from 'vitest'
import { HookRegistry } from '../../../src/hooks/hook-registry'
import type { HookDefinition } from '../../../src/hooks/types'

describe('HookRegistry', () => {
  describe('register and getMatching', () => {
    it('returns hooks matching event type', () => {
      const registry = new HookRegistry()
      const hook: HookDefinition = {
        event: 'PreToolUse',
        type: 'command',
        command: 'echo test',
      }
      registry.register(hook)
      const matches = registry.getMatching('PreToolUse', { event: 'PreToolUse', toolName: 'Write' })
      expect(matches).toHaveLength(1)
      expect(matches[0]).toBe(hook)
    })

    it('returns empty for non-matching event', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'PreToolUse', type: 'command', command: 'echo' })
      const matches = registry.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Write' })
      expect(matches).toHaveLength(0)
    })

    it('filters by matcher regex', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'PostToolUse', matcher: 'Write|Edit', type: 'command', command: 'echo' })
      expect(registry.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Write' })).toHaveLength(1)
      expect(registry.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Edit' })).toHaveLength(1)
      expect(registry.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Bash' })).toHaveLength(0)
    })

    it('null matcher matches all tools', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'PreToolUse', type: 'command', command: 'echo' })
      expect(registry.getMatching('PreToolUse', { event: 'PreToolUse', toolName: 'AnyTool' })).toHaveLength(1)
    })

    it('filters by if condition (file extension)', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'PostToolUse', matcher: 'Write', if: 'Write(*.ts)', type: 'command', command: 'echo' })
      expect(registry.getMatching('PostToolUse', {
        event: 'PostToolUse', toolName: 'Write', filePaths: ['/src/foo.ts'],
      })).toHaveLength(1)
      expect(registry.getMatching('PostToolUse', {
        event: 'PostToolUse', toolName: 'Write', filePaths: ['/src/foo.py'],
      })).toHaveLength(0)
    })

    it('Stop hooks ignore matcher and if', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'Stop', type: 'command', command: 'npm test' })
      expect(registry.getMatching('Stop', { event: 'Stop' })).toHaveLength(1)
    })
  })

  describe('isEmpty', () => {
    it('returns true when no hooks registered', () => {
      expect(new HookRegistry().isEmpty()).toBe(true)
    })
    it('returns false after registering a hook', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'Stop', type: 'command', command: 'echo' })
      expect(registry.isEmpty()).toBe(false)
    })
  })
})
