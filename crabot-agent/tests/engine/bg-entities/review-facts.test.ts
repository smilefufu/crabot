import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry.js'
import { readReviewBackgrounds } from '../../../src/engine/bg-entities/review-facts.js'
import type { BgAgentRegistryRecord, BgShellRegistryRecord } from '../../../src/engine/bg-entities/types.js'
import type { TraceStore } from '../../../src/core/trace-store.js'

describe('后台自省事实只读快照', () => {
  let dir: string
  let registry: BgEntityRegistry
  let shell: BgShellRegistryRecord
  const spans: any[] = []
  const traces = { getFullTrace: vi.fn(async () => ({ spans })) } as unknown as TraceStore
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'review-background-'))
    registry = new BgEntityRegistry(join(dir, 'registry.json'))
    shell = { type: 'shell', entity_id: 'shell_1', owner: { worker_id: 'worker', friend_id: 'f', subagent_id: 'agent_1' },
      status: 'running', spawned_by_task_id: 'worker', spawned_at: '2026-10-01T00:00:00Z', last_activity_at: 'then',
      exit_code: null, ended_at: null, command: 'unused', pid: 1, pgid: 1, process_started_at: 'then', log_file: join(dir, 'out.log') }
    await fs.writeFile(shell.log_file, '已完成探测')
    await registry.register(shell)
    spans.length = 0
  })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const read = () => readReviewBackgrounds(registry, traces, ['worker'])
  it('running且输出稳定可以复用；读取及last_activity_at不消费输出或制造变化', async () => {
    const before = await read()
    expect(before.worker).toMatchObject({ canSkip: true, active: true })
    await registry.update(shell.entity_id, { last_activity_at: 'later' })
    expect(await read()).toEqual(before)
    expect((await registry.get(shell.entity_id))?.status).toBe('running')
    await fs.appendFile(shell.log_file, '新输出')
    expect((await read()).worker.fingerprint).not.toBe(before.worker.fingerprint)
  })
  it.each(['notification', 'stalled', 'missing-output'])('%s禁止跳过', async mode => {
    if (mode === 'notification') await registry.update(shell.entity_id,
      { exit_notification: { status: 'pending', attempts: 4, updated_at: 'now' } })
    if (mode === 'stalled') await registry.update(shell.entity_id, { status: 'stalled' })
    if (mode === 'missing-output') await fs.unlink(shell.log_file)
    expect((await read()).worker.canSkip).toBe(false)
  })
  it('stalled即使已投递通知仍有后台责任，不能当作已关闭历史略过', async () => {
    await registry.update(shell.entity_id, { status: 'stalled' })
    await registry.settleExitNotification(shell.entity_id, 'delivered')
    expect((await read()).worker).toMatchObject({ canSkip: false, active: true })
  })
  it('child无文本时的新业务工具进展也使事实变化，纯请求诊断不制造变化', async () => {
    const child: BgAgentRegistryRecord = { ...shell, type: 'agent', entity_id: 'agent_1', owner: { worker_id: 'worker', friend_id: 'f' },
      output_file: join(dir, 'child.txt'), task_description: '业务', messages_log_file: 'unused', result_file: null, trace_id: 'child-trace' }
    await fs.writeFile(child.output_file!, '')
    await registry.register(child)
    const before = await read()
    spans.push({ span_id: 'retry', type: 'decision', status: 'failed', details: { kind: 'worker_runtime' } })
    expect(await read()).toEqual(before)
    spans.push({ span_id: 'call', type: 'tool_call', status: 'running', details: { tool_name: 'Shell', input_summary: '业务' } })
    const started = await read()
    expect(started.worker.fingerprint).not.toBe(before.worker.fingerprint)
    spans[1].status = 'completed'
    spans[1].details.output_summary = '成功'
    expect((await read()).worker.fingerprint).not.toBe(started.worker.fingerprint)
    await fs.appendFile(child.output_file!, '过程文本')
    expect((await read()).worker.fingerprint).not.toBe(started.worker.fingerprint)
  })
  it('退出、替换、截断都改变事实；其它owner不进入快照', async () => {
    const before = await read()
    await registry.register({ ...shell, entity_id: 'other', owner: { worker_id: 'other-worker', friend_id: 'f' } })
    expect(await read()).toEqual(before)
    await fs.writeFile(shell.log_file, '')
    expect((await read()).worker.fingerprint).not.toBe(before.worker.fingerprint)
    await registry.update(shell.entity_id, { status: 'completed', exit_code: 0 })
    expect((await read()).worker.canSkip).toBe(false)
    await registry.settleExitNotification(shell.entity_id, 'delivered')
    expect((await read()).worker.active).toBe(false)
    expect((await read()).worker.fingerprint).not.toBe(before.worker.fingerprint)
  })
})
