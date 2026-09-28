import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutputTool } from '../../src/engine/tools/output-tool.js'
import type { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
afterEach(() => vi.useRealTimers())
async function fixture(type: 'agent' | 'shell') {
  const dir = await mkdtemp(join(tmpdir(), 'unified-output-')); const file = join(dir, 'output')
  await writeFile(file, '')
  const record = { entity_id: `${type}_test`, type, status: 'running', exit_code: null,
    owner: { friend_id: 'f', worker_id: 'w' }, spawned_by_task_id: 'w',
    log_file: file, output_file: file, result_file: null }
  const tool = createOutputTool({ taskId: 'w', ownerWorkerId: 'w', cursorMap: new Map(),
    registry: { get: async () => record, update: async () => {} } as unknown as BgEntityRegistry })
  return { record, tool, file, close: () => rm(dir, { recursive: true, force: true }) }
}
describe('unified Output', () => {
  it('reads child text incrementally and terminal without new text', async () => {
    const f = await fixture('agent')
    try {
      await writeFile(f.file, '处理中\n')
      const first = await f.tool.call({ entity_id: 'agent_test' }, {})
      expect(first.isError).toBe(false); expect(first.output).toContain('处理中')
      const second = await f.tool.call({ entity_id: 'agent_test' }, { hasPendingExternalInput: () => true })
      expect(second.output).not.toContain('处理中'); expect(second.output).toContain('external_input')
      f.record.status = 'completed'
      expect((await f.tool.call({ entity_id: 'agent_test' }, {})).output).toContain('terminal')
    } finally { await f.close() }
  })
  it('new input returns without consuming output', async () => {
    const f = await fixture('shell')
    try {
      await writeFile(f.file, 'keep me')
      expect((await f.tool.call({ entity_id: 'shell_test' }, { hasPendingExternalInput: () => true })).output).toContain('external_input')
      expect((await f.tool.call({ entity_id: 'shell_test' }, {})).output).toContain('keep me')
    } finally { await f.close() }
  })
  it('pages UTF-8 child text without repeats or replacement characters', async () => {
    const f = await fixture('agent')
    try {
      const text = '中'.repeat(40000); await writeFile(f.file, text)
      const first = await f.tool.call({ entity_id: 'agent_test', timeout_ms: 0 }, {})
      const second = await f.tool.call({ entity_id: 'agent_test', timeout_ms: 0 }, {})
      expect(first.output).not.toContain('�'); expect(second.output).not.toContain('�')
      expect((first.output.match(/中/g) ?? []).length + (second.output.match(/中/g) ?? []).length).toBe(40000)
      expect((await f.tool.call({ entity_id: 'agent_test', from_offset: 0, timeout_ms: 0 }, {})).output).toBe(first.output)
    } finally { await f.close() }
  })
  it('does not expose sibling or fork output through a mainline identity', async () => {
    const f = await fixture('agent')
    try {
      Object.assign(f.record.owner, { incarnation_id: 'fork' })
      expect((await f.tool.call({ entity_id: 'agent_test', timeout_ms: 0 }, {})).isError).toBe(true)
      Object.assign(f.record.owner, { incarnation_id: undefined, subagent_id: 'sibling' })
      expect((await f.tool.call({ entity_id: 'agent_test', timeout_ms: 0 }, {})).isError).toBe(true)
    } finally { await f.close() }
  })
  it('rejects another worker before reading', async () => {
    const f = await fixture('agent'); f.record.owner.worker_id = 'other'
    try { expect((await f.tool.call({ entity_id: 'agent_test', timeout_ms: 0 }, {})).isError).toBe(true) }
    finally { await f.close() }
  })
})
