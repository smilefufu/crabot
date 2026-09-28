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
  const tool = createOutputTool({ taskId: 'w', ownerWorkerId: 'w', cursorMap: new Map(), registry: { get: async () => record, update: async () => {} } as unknown as BgEntityRegistry })
  return { tool, record, file, close: () => rm(dir, { recursive: true, force: true }) }
}
describe('Output waiting contract', () => {
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
