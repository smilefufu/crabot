import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as resources from '../../../src/engine/tool-resource-scope'
import { createKillTool } from '../../../src/engine/tools/kill-tool'
import { createBashTool } from '../../../src/engine/tools/bash-tool'
import { runShellWithGrace } from '../../../src/engine/bg-entities/bg-shell'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'

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
