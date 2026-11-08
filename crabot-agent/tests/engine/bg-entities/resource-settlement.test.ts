import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as resources from '../../../src/engine/tool-resource-scope'
import { createKillTool } from '../../../src/engine/tools/kill-tool'
import { createBashTool } from '../../../src/engine/tools/bash-tool'
import { runShellWithGrace } from '../../../src/engine/bg-entities/bg-shell'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import type { BgShellRegistryRecord } from '../../../src/engine/bg-entities/types'

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-resource-')); dirs.push(root); vi.stubEnv('DATA_DIR', root)
  const registry = new BgEntityRegistry(path.join(root, 'bg.json'))
  const owner = { friend_id: 'fixture', worker_id: 'w', incarnation_id: 'i' }
  return { root, registry, owner }
}
const exhausted: resources.ToolResourceResult = { status: 'limit', exit_code: 0, signal: null, memory_events: {}, pids_events: { max: 1 },
  memory_peak_bytes: 100, cleanup: 'complete', message: 'Tool resource budget exhausted; execution may have partial side effects. Command was not replayed.' }
it('surfaces resource exhaustion as a tool error even when the inline shell exited zero', async () => {
  const { root, registry, owner } = await fixture()
  vi.spyOn(resources, 'finishToolResources').mockResolvedValue(exhausted)
  const tool = createBashTool(() => root, undefined, { registry, owner, taskId: 'w' })
  const result = await tool.call({ command: 'printf side-effect' }, {})
  expect(result.isError).toBe(true); expect(result.output).toContain('partial side effects'); expect(result.output).toContain('side-effect')
})
it('keeps owner, failure metadata and one exit notification across background promotion', async () => {
  const { root, registry, owner } = await fixture()
  vi.spyOn(resources, 'finishToolResources').mockResolvedValue(exhausted)
  const exits = vi.fn()
  const result = await runShellWithGrace({ command: 'sleep .1', cwd: root, registry, owner, spawned_by_task_id: 'w', gracePeriodMs: 5, onShellExit: exits })
  expect(result.kind).toBe('background')
  if (result.kind !== 'background') throw new Error('not promoted')
  await vi.waitFor(() => expect(exits).toHaveBeenCalledTimes(1))
  const record = await registry.get(result.entity_id)
  expect(record).toMatchObject({ status: 'failed', owner, exit_code: 0, resource_result: exhausted, exit_notification: { status: 'pending', attempts: 0 } })
  expect(await fs.readFile((record as any).log_file, 'utf8')).toContain('partial side effects')
})

it('records stop intent before the protected exit, and publishes killed only after verified cleanup', async () => {
  const { root, registry, owner } = await fixture()
  const stopped = { ...exhausted, status: 'ok' as const, pids_events: {}, message: undefined }
  vi.spyOn(resources, 'finishToolResources').mockResolvedValue(stopped)
  vi.spyOn(resources, 'toolScopeForChild').mockReturnValue({ version: 1, id: 'fixture' } as resources.ToolResourceScope)
  const exits = vi.fn()
  vi.spyOn(resources, 'stopResourceScope').mockImplementation(async () => { await vi.waitFor(() => expect(exits).toHaveBeenCalledTimes(1)); return stopped })
  const shell = await runShellWithGrace({ command: 'sleep .15', cwd: root, registry, owner, spawned_by_task_id: 'w', gracePeriodMs: 5, onShellExit: exits })
  if (shell.kind !== 'background') throw new Error('not promoted')
  const kill = createKillTool({ registry, cursorMap: new Map(), taskId: 'w', ownerWorkerId: 'w', ownerIncarnationId: 'i' })
  expect((await kill.call({ entity_id: shell.entity_id }, {})).isError).toBe(false)
  expect(exits.mock.calls[0][0].status).toBe('killed')
  expect(await registry.get(shell.entity_id)).toMatchObject({ status: 'killed', exit_notification: { status: 'pending', attempts: 0 } })
})

it('retains a missing protected scope as unknown without blocking other startup recovery', async () => {
  const { root, registry, owner } = await fixture()
  const now = new Date().toISOString()
  const scope: resources.ToolResourceScope = { version: 1, id: '00000000-0000-0000-0000-000000000001',
    root: path.join(root, 'missing-cgroup-root'), root_inode: 1, inode: 2, device: 1,
    memory_bytes: 100, tasks: 10, cpu_quota: 2 }
  const shell: BgShellRegistryRecord = { entity_id: 'unknown-shell', type: 'shell', status: 'running', owner,
    spawned_by_task_id: 'w', spawned_at: now, last_activity_at: now, exit_code: null, ended_at: null,
    command: 'never replay', log_file: path.join(root, 'unknown.log'), pid: process.pid, pgid: process.pid,
    process_started_at: now, resource_scope: scope }
  await fs.writeFile(shell.log_file, 'original output\n')
  await registry.register(shell)
  await registry.register({ ...shell, entity_id: 'pending-shell', status: 'failed', resource_scope: undefined,
    exit_code: -1, ended_at: now, exit_notification: { status: 'pending', updated_at: now, attempts: 0 } })
  await registry.register({ ...shell, entity_id: 'alive-shell', resource_scope: undefined })
  await registry.register({ entity_id: 'agent-after-unknown', type: 'agent', status: 'running', owner,
    spawned_by_task_id: 'w', spawned_at: now, last_activity_at: now, exit_code: null, ended_at: null,
    task_description: 'original task', messages_log_file: path.join(root, 'agent.log'), result_file: null })
  const reap = vi.spyOn(registry, 'reapShellIfDead').mockResolvedValue(null)

  for (let restart = 0; restart < 2; restart++) {
    const recovered = await registry.recoverPersistent()
    expect(recovered.alive.map(record => record.entity_id)).toEqual(['alive-shell'])
    expect(recovered.deadShells.map(record => record.entity_id)).toEqual(['pending-shell'])
    expect(await registry.get('unknown-shell')).toMatchObject({ status: 'running', owner, command: 'never replay',
      resource_scope: scope, exit_code: null, ended_at: null, resource_result: { status: 'unknown', cleanup: 'unknown' } })
  }
  expect(await registry.get('agent-after-unknown')).toMatchObject({ status: 'stalled', owner })
  expect(reap.mock.calls.map(([record]) => record.entity_id)).toEqual(['alive-shell', 'alive-shell'])
  expect(await fs.readFile(shell.log_file, 'utf8')).toContain('original output\n')
  expect(await fs.readFile(shell.log_file, 'utf8')).toContain('cleanup is unknown')
})
