import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagerLoop, managerToolLoadingModeForKey, type ManagerLoopDeps } from '../../src/manager/loop.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import { ManagerToolCatalog, NORMAL_MANAGER_CORE_NAMES, type ManagerToolFaceState } from '../../src/manager/tools/tool-catalog.js'
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
  it('shadow traces project the new fixed family loader without losing observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manager-family-shadow-'))
    try {
      vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_MODE', 'shadow')
      vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_KEYS', '')
      const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' },
        call: async () => ({ output: '', isError: false }) })
      const appendSpan = vi.fn()
      const loop = new ManagerLoop({
        key: 'channel::session', managerKey: () => 'channel::session', isSystemThread: false,
        store: new ManagerSessionStore(directory), policy: { keepRecent: 3, hardCapTokens: 1_000_000 },
        toolFace: (_wake, state) => {
          state!.catalog ??= new ManagerToolCatalog(NORMAL_MANAGER_CORE_NAMES
            .filter(name => name !== 'search_tools' && name !== 'load_tool_family').map(tool), 'normal')
          state!.searchTool ??= tool('search_tools')
          state!.familyTool ??= tool('load_tool_family')
          return state!.catalog.project(state!, state!.searchTool)
        },
        promptInputs: () => ({}), harness: { listWorkers: async () => [] } as never,
        now: () => new Date(), markPendingReply() {}, hasPendingReply: () => false,
        model: () => 'model', adapter: () => ({ updateConfig() {}, async *stream() { yield* chunksFromContent([], 'end_turn') } }),
        traceWriter: { startEpisode: vi.fn(), appendSpan, finishSpan: vi.fn(), finishEpisode: vi.fn(), addSpawnedWorker: vi.fn() },
      })
      await loop.wakeUp({ wake: { kind: 'self_wake', reason: 'fixture' }, received_at: new Date().toISOString(), timezone: 'UTC' })
      const llm = appendSpan.mock.calls.map(([, span]) => span).filter(span => span.type === 'llm_call')
      expect(llm).toHaveLength(1)
      expect(llm[0].details).toMatchObject({ visible_tool_count: 15, shadow_core_count: 15, family_load_count: 0 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

})
