import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagerLoop, managerToolLoadingModeForKey, type ManagerLoopDeps } from '../../src/manager/loop.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import { type ManagerToolFaceState } from '../../src/manager/tools/tool-catalog.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => vi.unstubAllEnvs())

describe('Manager rollout controls', () => {
  it.each(['', 'unknown', 'FULL'])('defaults invalid mode %j to full', mode => {
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_MODE', mode)
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_KEYS', '')
    expect(managerToolLoadingModeForKey('channel::session')).toBe('full')
  })

  it.each(['full', 'shadow', 'progressive'])('%s cohort uses exact stable keys, not prefixes or hashing', mode => {
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_MODE', mode)
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_KEYS', ' ch-a::session , ch-b::group, ch-a::session ')
    for (let i = 0; i < 10; i++) {
      expect(managerToolLoadingModeForKey('ch-a::session')).toBe(mode)
      expect(managerToolLoadingModeForKey('ch-b::group')).toBe(mode)
      expect(managerToolLoadingModeForKey('ch-a::session-longer')).toBe('full')
      expect(managerToolLoadingModeForKey('ch-c::session')).toBe('full')
    }
  })

  it('mode is fixed within an episode; rollback starts at the next admission without prompt changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manager-rollout-'))
    try {
      vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_MODE', 'progressive')
      vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_KEYS', 'channel::session')
      const states: ManagerToolFaceState[] = []
      const prompts: string[] = []
      let requests = 0
      const tool = { name: 'read_fixture', description: 'read', inputSchema: { type: 'object', properties: {} },
        isReadOnly: true, call: async () => ({ output: 'ok', isError: false }) }
      const deps: ManagerLoopDeps = {
        key: 'channel::session', managerKey: () => 'channel::session', isSystemThread: false,
        store: new ManagerSessionStore(directory), policy: { keepRecent: 3, hardCapTokens: 1_000_000 },
        toolFace: (_wake, state) => { states.push(state!); return [tool] },
        promptInputs: () => ({}), harness: { listWorkers: async () => [] } as never,
        now: () => new Date(), markPendingReply() {}, hasPendingReply: () => false,
        model: () => 'model', adapter: () => ({
          updateConfig() {}, async *stream(params) {
            requests++
            prompts.push(params.systemPrompt)
            if (requests === 1) {
              vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_MODE', 'full')
              yield* chunksFromContent([{ type: 'tool_use', id: 'once', name: tool.name, input: {} }], 'tool_use')
            } else yield* chunksFromContent([], 'end_turn')
          },
        }),
      }
      const loop = new ManagerLoop(deps)
      const wake = { wake: { kind: 'schedule' as const, scheduleId: 'fixture', title: 'fixture', description: '' },
        received_at: '2026-09-12T00:00:00Z', timezone: 'UTC' }
      await loop.wakeUp(wake)
      expect(requests).toBe(2)
      expect(new Set(states).size).toBe(1)
      expect(states.every(state => state.mode === 'progressive')).toBe(true)
      states.length = 0
      await loop.wakeUp(wake)
      expect(states.every(state => state.mode === 'full')).toBe(true)
      expect(new Set(prompts).size).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
