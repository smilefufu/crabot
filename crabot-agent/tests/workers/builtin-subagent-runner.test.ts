import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuiltinSubagentRunner } from '../../src/workers/builtin/subagent-runner.js'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import type { TraceStore } from '../../src/core/trace-store.js'
import type { LSPManager } from '../../src/lsp/lsp-manager.js'

describe('BuiltinSubagentRunner restart recovery', () => {
  it('marks only Worker-owned running children as interrupted after an Agent restart', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'builtin-subagent-recovery-'))
    try {
      const registry = new BgEntityRegistry(join(dir, 'registry.json'))
      await registry.register({
        entity_id: 'agent-worker-child', type: 'agent', status: 'running',
        subagent_type: 'code_writer', trace_id: 'trace-child', task_description: '实现变更',
        messages_log_file: join(dir, 'child.jsonl'), result_file: null,
        owner: { friend_id: '__builtin_worker__', worker_id: 'worker-1' }, spawned_by_task_id: 'worker-1',
        spawned_at: '2026-08-22T00:00:00.000Z', exit_code: null, ended_at: null, last_activity_at: '2026-08-22T00:00:00.000Z',
      })
      await registry.register({
        entity_id: 'agent-other-owner', type: 'agent', status: 'running',
        task_description: '不属于 Worker', messages_log_file: join(dir, 'other.jsonl'), result_file: null,
        owner: { friend_id: 'friend-1' }, spawned_by_task_id: 'task-1',
        spawned_at: '2026-08-22T00:00:00.000Z', exit_code: null, ended_at: null, last_activity_at: '2026-08-22T00:00:00.000Z',
      })
      const runner = new BuiltinSubagentRunner({} as TraceStore, {} as LSPManager, undefined, registry)

      await expect(runner.recoverAfterRestart()).resolves.toBe(1)
      await expect(runner.list('worker-1')).resolves.toMatchObject([{ subagent_id: 'agent-worker-child', status: 'interrupted' }])
      await expect(registry.get('agent-other-owner')).resolves.toMatchObject({ status: 'running' })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
