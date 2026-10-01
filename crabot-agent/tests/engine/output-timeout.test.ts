import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutputTool } from '../../src/engine/tools/output-tool.js'
import type { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
const clock = vi.hoisted(() => ({ now: 0, tick: undefined as undefined | (() => Promise<void>) }))
vi.mock('../../src/engine/retry-utils.js', async importOriginal => ({
  ...await importOriginal<object>(), sleep: async (ms: number) => { clock.now += ms; await clock.tick?.() },
}))
afterEach(() => { vi.restoreAllMocks(); clock.tick = undefined })
async function setup(type: 'shell' | 'agent') {
  const dir = await mkdtemp(join(tmpdir(), 'output-timeout-')); const file = join(dir, 'out'); await writeFile(file, '')
  clock.now = 0; vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
  const record = { entity_id: `${type}_id`, type, status: 'running', owner: { worker_id: 'w' }, spawned_by_task_id: 'w', log_file: file, output_file: file }
  const deps = { taskId: 'w', ownerWorkerId: 'w', cursorMap: new Map<string, number>(), registry: { get: async () => record, update: async () => {} } as unknown as BgEntityRegistry }
  const tool = createOutputTool(deps)
  return { tool, deps, record, file, close: () => rm(dir, { recursive: true, force: true }) }
}
describe('Output waiting contract', () => {
  it.each([
    ['agent', [15, 30, 60, 120, 120]],
    ['shell', [2, 4, 8, 16, 32, 64, 120, 120]],
  ] as const)('%s backs off only on consecutive empty timeouts', async (type, minutes) => {
    const f = await setup(type)
    try {
      for (const minute of minutes) {
        const start = clock.now
        const onOutputWait = vi.fn()
        expect((await f.tool.call({ entity_id: f.record.entity_id }, { onOutputWait })).output).toContain('reason: timeout')
        expect(clock.now - start).toBe(minute * 60_000)
        expect(onOutputWait.mock.calls).toEqual([[start + minute * 60_000], [undefined]])
      }
    } finally { await f.close() }
  })
  it('preserves the wait across tool assembly but isolates new callers', async () => {
    const f = await setup('agent'); const context = { outputWaitState: new Map() }
    try {
      await f.tool.call({ entity_id: 'agent_id' }, context)
      const rebuilt = createOutputTool(f.deps); const start = clock.now
      await rebuilt.call({ entity_id: 'agent_id' }, context)
      expect(clock.now - start).toBe(30 * 60_000)
      const freshStart = clock.now
      await rebuilt.call({ entity_id: 'agent_id' }, { outputWaitState: new Map() })
      expect(clock.now - freshStart).toBe(15 * 60_000)
    } finally { await f.close() }
  })
  it('resets on new bytes, not explicit rereading of old output', async () => {
    const f = await setup('agent')
    try {
      await f.tool.call({ entity_id: 'agent_id' }, {})
      await appendFile(f.file, 'one')
      await f.tool.call({ entity_id: 'agent_id' }, {})
      let start = clock.now
      const onOutputWait = vi.fn()
      await f.tool.call({ entity_id: 'agent_id' }, { onOutputWait })
      expect(clock.now - start).toBe(15 * 60_000)
      expect(onOutputWait.mock.calls).toEqual([[start + 15 * 60_000], [undefined]])
      await f.tool.call({ entity_id: 'agent_id', from_offset: 0 }, {})
      start = clock.now
      await f.tool.call({ entity_id: 'agent_id' }, {})
      expect(clock.now - start).toBe(30 * 60_000)
    } finally { await f.close() }
  })
  it('one concurrent timeout round advances only one level', async () => {
    const f = await setup('agent')
    try {
      await Promise.all([1, 2, 3].map(() => f.tool.call({ entity_id: 'agent_id' }, {})))
      const start = clock.now
      await f.tool.call({ entity_id: 'agent_id' }, {})
      expect(clock.now - start).toBe(30 * 60_000)
    } finally { await f.close() }
  })
  it('an older wait cannot overwrite a reset from a parallel progress read', async () => {
    const f = await setup('agent')
    try {
      await f.tool.call({ entity_id: 'agent_id' }, {})
      clock.tick = async () => {
        clock.tick = undefined
        await appendFile(f.file, 'new progress')
        expect((await f.tool.call({ entity_id: 'agent_id' }, {})).output).toContain('new progress')
      }
      await f.tool.call({ entity_id: 'agent_id' }, {})
      const start = clock.now
      await f.tool.call({ entity_id: 'agent_id' }, {})
      expect(clock.now - start).toBe(15 * 60_000)
    } finally { await f.close() }
  })
  it('input and read errors do not increase or reset the wait', async () => {
    const f = await setup('agent')
    try {
      await f.tool.call({ entity_id: 'agent_id' }, {})
      expect((await f.tool.call({ entity_id: 'agent_id' }, { hasPendingExternalInput: () => true })).output).toContain('external_input')
      expect((await f.tool.call({ entity_id: 'agent_id', from_offset: 99 }, {})).isError).toBe(true)
      const start = clock.now
      await f.tool.call({ entity_id: 'agent_id' }, {})
      expect(clock.now - start).toBe(30 * 60_000)
    } finally { await f.close() }
  })
  it('input during the registry activity write does not consume the output', async () => {
    const f = await setup('agent'); let pending = false
    try {
      await appendFile(f.file, 'preserved')
      vi.spyOn(f.deps.registry, 'update').mockImplementationOnce(async () => { pending = true; return undefined })
      expect((await f.tool.call({ entity_id: 'agent_id' }, { hasPendingExternalInput: () => pending })).output).toContain('external_input')
      expect(f.deps.cursorMap.size).toBe(0)
      expect((await f.tool.call({ entity_id: 'agent_id' }, {})).output).toContain('preserved')
    } finally { await f.close() }
  })
  it.each(['external_input', 'new_output', 'terminal', 'aborted'])('two-hour wait returns promptly on %s', async reason => {
    const f = await setup('agent'); const controller = new AbortController(); let pending = false
    try {
      for (let i = 0; i < 3; i++) await f.tool.call({ entity_id: 'agent_id' }, {})
      const start = clock.now
      clock.tick = async () => {
        if (reason === 'external_input') { pending = true; await appendFile(f.file, 'unconsumed') }
        if (reason === 'new_output') await appendFile(f.file, 'progress')
        if (reason === 'terminal') f.record.status = 'completed'
        if (reason === 'aborted') controller.abort()
      }
      const onOutputWait = vi.fn()
      const result = await f.tool.call({ entity_id: 'agent_id' }, { abortSignal: controller.signal, hasPendingExternalInput: () => pending, onOutputWait })
      expect(onOutputWait.mock.calls).toEqual([[start + 120 * 60_000], [undefined]])
      expect(result.output).toContain(`reason: ${reason}`)
      expect(clock.now - start).toBe(2000)
      if (reason === 'external_input') {
        expect(f.deps.cursorMap.size).toBe(0)
        clock.tick = undefined
        expect((await f.tool.call({ entity_id: 'agent_id' }, {})).output).toContain('unconsumed')
      }
    } finally { await f.close() }
  })
  it.each([['agent', 900000], ['shell', 120000]] as const)('%s uses its default regardless of legacy block', async (type, timeout) => {
    const f = await setup(type)
    try { const r = await f.tool.call({ entity_id: f.record.entity_id, block: false }, {}); expect(r.output).toContain('timeout'); expect(clock.now).toBe(timeout); expect(f.record.status).toBe('running') }
    finally { await f.close() }
  })
  it.each([0, 120000, -1, 'invalid', null])('ignores legacy timeout_ms=%s for child reads', async timeout_ms => {
    const f = await setup('agent')
    try {
      const result = await f.tool.call({ entity_id: 'agent_id', timeout_ms }, {})
      expect(result.isError).toBe(false)
      expect(result.output).toContain('timeout')
      expect(clock.now).toBe(900000)
      expect(f.record.status).toBe('running')
    } finally { await f.close() }
  })
  it.each(['wrong_owner', 'missing', 'legacy', 'read_error', 'terminal', 'new_output', 'external_input'])(
    'does not register a wait for initial %s', async reason => {
      const f = await setup('agent'); const onOutputWait = vi.fn()
      try {
        if (reason === 'wrong_owner') f.record.owner.worker_id = 'other'
        if (reason === 'missing') vi.spyOn(f.deps.registry, 'get').mockResolvedValue(undefined)
        if (reason === 'legacy') f.record.output_file = ''
        if (reason === 'terminal') f.record.status = 'completed'
        if (reason === 'new_output') await appendFile(f.file, 'ready')
        await f.tool.call({ entity_id: 'agent_id', ...(reason === 'read_error' ? { from_offset: 99 } : {}) },
          { onOutputWait, hasPendingExternalInput: () => reason === 'external_input' })
        expect(onOutputWait).not.toHaveBeenCalled()
      } finally { await f.close() }
    },
  )
  it.each(['read_error', 'registry_error'])('clears a registered wait after %s', async reason => {
    const f = await setup('agent'); const onOutputWait = vi.fn()
    try {
      clock.tick = async () => {
        if (reason === 'read_error') f.record.output_file = await mkdtemp(join(tmpdir(), 'output-error-'))
        else vi.spyOn(f.deps.registry, 'get').mockRejectedValue(new Error('registry unavailable'))
      }
      const result = f.tool.call({ entity_id: 'agent_id' }, { onOutputWait })
      if (reason === 'registry_error') await expect(result).rejects.toThrow('registry unavailable')
      else expect((await result).isError).toBe(true)
      expect(onOutputWait.mock.calls).toEqual([[900000], [undefined]])
    } finally {
      if (f.record.output_file !== f.file) await rm(f.record.output_file, { recursive: true, force: true })
      await f.close()
    }
  })
  it('keeps offset validation', async () => {
    const f = await setup('agent')
    try { expect((await f.tool.call({ entity_id: 'agent_id', from_offset: -1 }, {})).isError).toBe(true) }
    finally { await f.close() }
  })
  it('returns on child intermediate output before the long timeout', async () => {
    const f = await setup('agent'); clock.tick = async () => { await appendFile(f.file, 'progress') }
    try { expect((await f.tool.call({ entity_id: 'agent_id' }, {})).output).toContain('progress'); expect(clock.now).toBe(2000) }
    finally { await f.close() }
  })
  it.each(['shell', 'agent'] as const)('%s returns terminal before the wait limit', async type => {
    const f = await setup(type); clock.tick = async () => { f.record.status = 'completed' }
    try {
      expect((await f.tool.call({ entity_id: f.record.entity_id }, {})).output).toContain('terminal')
      expect(clock.now).toBe(2000)
    } finally { await f.close() }
  })
  it('yields to input arriving during read without consuming that output', async () => {
    const f = await setup('agent'); await appendFile(f.file, 'retained')
    let probes = 0
    try {
      expect((await f.tool.call({ entity_id: 'agent_id' }, { hasPendingExternalInput: () => ++probes === 2 })).output).toContain('external_input')
      expect((await f.tool.call({ entity_id: 'agent_id' }, {})).output).toContain('retained')
    } finally { await f.close() }
  })
  it('cancels an active wait without stopping the target', async () => {
    const f = await setup('agent'); const controller = new AbortController()
    clock.tick = async () => { controller.abort() }
    try {
      expect((await f.tool.call({ entity_id: 'agent_id' }, { abortSignal: controller.signal })).output).toContain('aborted')
      expect(f.record.status).toBe('running'); expect(clock.now).toBe(2000)
    } finally { await f.close() }
  })
  it('all parallel waits yield to new input without cancelling the target', async () => {
    const f = await setup('agent'); let pending = false; clock.tick = async () => { pending = true }
    try {
      const results = await Promise.all([1, 2].map(() => f.tool.call({ entity_id: 'agent_id' }, { hasPendingExternalInput: () => pending })))
      expect(results.every(r => r.output.includes('external_input'))).toBe(true); expect(f.record.status).toBe('running')
    } finally { await f.close() }
  })
  it('ignores legacy timeout and still honors abort', async () => {
    const f = await setup('shell')
    try {
      expect((await f.tool.call({ entity_id: 'shell_id', timeout_ms: 10 }, {})).output).toContain('timeout'); expect(clock.now).toBe(120000)
      const controller = new AbortController(); controller.abort()
      expect((await f.tool.call({ entity_id: 'shell_id' }, { abortSignal: controller.signal })).output).toContain('aborted')
    } finally { await f.close() }
  })
})
