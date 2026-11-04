import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagerLoop, type ManagerLoopDeps } from '../../src/manager/loop.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import { ManagerToolCatalog, NORMAL_MANAGER_CORE_NAMES, type ManagerToolFaceState } from '../../src/manager/tools/tool-catalog.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => vi.unstubAllEnvs())

function catalogFace(state: ManagerToolFaceState, inspect: ReturnType<typeof vi.fn>) {
  if (!state.catalog) {
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' },
      call: async () => ({ output: '', isError: false }) })
    state.catalog = new ManagerToolCatalog([
      ...NORMAL_MANAGER_CORE_NAMES.filter(name => name !== 'search_tools' && name !== 'load_tool_family').map(tool),
      { ...tool('inspect_crabot'), call: inspect },
    ], 'normal', undefined, undefined, undefined, { crabot: ['inspect_crabot'] })
    state.searchTool = tool('search_tools')
    state.familyTool = { ...tool('load_tool_family'), call: async input => ({
      output: JSON.stringify(state.catalog!.loadFamily(state, input.family)), isError: false,
    }) }
  }
  return state.catalog.project(state, state.searchTool)
}

const legacySettings = [
  { mode: undefined, keys: undefined },
  { mode: '', keys: '' },
  { mode: 'full', keys: '' },
  { mode: 'shadow', keys: '' },
  { mode: 'unknown', keys: '' },
  { mode: 'progressive', keys: 'other::session' },
  { mode: 'full', keys: 'channel::session' },
  { mode: 'shadow', keys: 'other::session' },
]

describe('Manager always loads tools progressively', () => {
  it.each(legacySettings)('retired settings cannot expand the first request: %j', async ({ mode, keys }) => {
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_MODE', mode)
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_KEYS', keys)
    const directory = await mkdtemp(join(tmpdir(), 'manager-progressive-'))
    try {
      const observed: string[][] = []
      const inspect = vi.fn(async () => ({ output: 'ok', isError: false }))
      const deps: ManagerLoopDeps = {
        key: 'channel::session', managerKey: () => 'channel::session', isSystemThread: false,
        store: new ManagerSessionStore(directory), policy: { keepRecent: 3, hardCapTokens: 1_000_000 },
        toolFace: (_wake, state) => catalogFace(state!, inspect),
        promptInputs: () => ({}), harness: { listWorkers: async () => [] } as never,
        now: () => new Date(), markPendingReply() {}, hasPendingReply: () => false,
        model: () => 'model', adapter: () => ({ updateConfig() {}, async *stream(params) {
          observed.push(params.tools?.map(tool => tool.name) ?? [])
          yield* chunksFromContent([], 'end_turn')
        } }),
      }
      await new ManagerLoop(deps).wakeUp({ wake: { kind: 'self_wake', reason: 'fixture' },
        received_at: new Date().toISOString(), timezone: 'UTC' })
      expect(observed).toEqual([[...NORMAL_MANAGER_CORE_NAMES]])
      expect(inspect).not.toHaveBeenCalled()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('loads a requested family on the next request and resets it for the next episode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manager-family-next-turn-'))
    try {
      const observed: string[][] = []
      const inspect = vi.fn(async () => ({ output: 'ok', isError: false }))
      let requests = 0
      const deps: ManagerLoopDeps = {
        key: 'channel::session', managerKey: () => 'channel::session', isSystemThread: false,
        store: new ManagerSessionStore(directory), policy: { keepRecent: 3, hardCapTokens: 1_000_000 },
        toolFace: (_wake, state) => catalogFace(state!, inspect),
        promptInputs: () => ({}), harness: { listWorkers: async () => [] } as never,
        now: () => new Date(), markPendingReply() {}, hasPendingReply: () => false,
        model: () => 'model', adapter: () => ({ updateConfig() {}, async *stream(params) {
          observed.push(params.tools?.map(tool => tool.name) ?? [])
          requests++
          if (requests === 1) yield* chunksFromContent([
            { type: 'tool_use', id: 'load', name: 'load_tool_family', input: { family: 'crabot' } },
          ], 'tool_use')
          else if (requests === 2) yield* chunksFromContent([
            { type: 'tool_use', id: 'inspect', name: 'inspect_crabot', input: {} },
          ], 'tool_use')
          else yield* chunksFromContent([], 'end_turn')
        } }),
      }
      const loop = new ManagerLoop(deps)
      const wake = { wake: { kind: 'self_wake' as const, reason: 'fixture' },
        received_at: new Date().toISOString(), timezone: 'UTC' }
      await loop.wakeUp(wake)
      expect(observed).toEqual([
        [...NORMAL_MANAGER_CORE_NAMES],
        [...NORMAL_MANAGER_CORE_NAMES, 'inspect_crabot'],
        [...NORMAL_MANAGER_CORE_NAMES, 'inspect_crabot'],
      ])
      expect(inspect).toHaveBeenCalledOnce()
      vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_MODE', 'full')
      await loop.wakeUp(wake)
      expect(observed[3]).toEqual([...NORMAL_MANAGER_CORE_NAMES])
      expect(inspect).toHaveBeenCalledOnce()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
