import { describe, it, expect } from 'vitest'
import { createGuidanceTool, guidanceNames, guidanceCatalog, renderGuidance } from '../../src/guidance/catalog.js'
import { MANAGER_IDENTITY, assembleManagerSystemPrompt } from '../../src/manager/prompt.js'
import { BUILTIN_WORKER_PROMPT, assembleBuiltinWorkerPrompt } from '../../src/prompts/builtin-worker.js'
import { narrowWorkerPermissions, BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'
import { needsWorkerEventGuidance } from '../../src/manager/loop.js'

const context = {} as never
const base = { managerKey: 'fixture::user', isSystemThread: false } as const

describe('product guidance boundaries', () => {
  it('keeps short cores and role-specific catalogs; ordinary tasks receive no workflows', () => {
    expect(MANAGER_IDENTITY.replace(/\s/g, '').length).toBe(269)
    expect(BUILTIN_WORKER_PROMPT.replace(/\s/g, '').length).toBe(162)
    expect(BUILTIN_WORKER_PROMPT).not.toMatch(/主控|执行器|调用方/)
    expect(guidanceNames('manager')).toHaveLength(4)
    expect(guidanceNames('worker')).toHaveLength(3)
    const manager = assembleManagerSystemPrompt(base)
    expect(manager).toContain(guidanceCatalog('manager'))
    expect(manager).not.toContain('处理：')
    expect(manager).not.toContain('worker.diagnosis')
    const worker = assembleBuiltinWorkerPrompt({ workspaceRoot: '/fixture', imageAvailable: true })
    expect(worker).toContain(guidanceCatalog('worker'))
    expect(worker).not.toContain('manager.delegation')
    expect(worker).not.toContain('处理：')
  })
  it('loads only one named workflow, independent of user Skills or filesystem paths', async () => {
    const tool = createGuidanceTool('worker')
    expect(await tool.call({ name: 'worker.diagnosis' }, context)).toEqual({ isError: false, output: renderGuidance('worker', 'worker.diagnosis') })
    for (const input of [{ name: 'manager.delegation' }, { name: '../../secret' }, { name: 'worker.diagnosis', path: '/secret' }, {}]) {
      expect((await tool.call(input, context)).isError).toBe(true)
    }
  })
  it('keeps workflow bodies out of the static core and daily reflection independent', () => {
    const text = assembleManagerSystemPrompt(base)
    expect(text).not.toContain('## Guidance: manager.worker-events')
    expect(text).not.toContain('## Guidance: manager.workboard')
    const daily = assembleManagerSystemPrompt({ ...base, isBuiltinDailyReflection: true })
    expect(daily).toContain('本轮是后台每日反思')
    expect(daily).not.toContain('guidance')
    expect(daily).not.toContain(MANAGER_IDENTITY)
  })
  it.each([
    ['lifecycle_changed', {}, false], ['state_changed', { to: 'running' }, false],
    ['state_changed', { to: 'idle', turn_pending: true }, true],
    ['activity_available', { has_error: true }, true], ['interaction_required', {}, true], ['turn_completed', {}, true],
  ])('routes actual event %s %j', (kind, detail, expected) => {
    expect(needsWorkerEventGuidance({ kind, detail, worker_id: 'w', seq: 0, ts: '' } as never)).toBe(expected)
  })
  it('opens desktop only with an affirmative frozen principal; does not mutate the role ceiling', () => {
    expect(narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, null).tool_access.desktop).toBe(false)
    const denied = { ...BUILTIN_WORKER_PERMISSIONS, tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, desktop: false } }
    expect(narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, denied).tool_access.desktop).toBe(false)
    expect(narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, BUILTIN_WORKER_PERMISSIONS).tool_access.desktop).toBe(true)
    expect(BUILTIN_WORKER_PERMISSIONS.tool_access.desktop).toBe(true)
  })
})
