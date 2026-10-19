import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkspaceService } from './workspaces.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(options: Partial<ConstructorParameters<typeof WorkspaceService>[0]> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-admin-')))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const service = new WorkspaceService({ dataRoot: root, ...options })
  cleanup.push(() => service.close())
  await service.initialize()
  return { root, service }
}
async function settled(service: WorkspaceService, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await service.usage(id)
    if (!['pending', 'measuring'].includes(result.usage.status)) return result.usage
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('scan did not finish')
}
it('lists stable projects and one default; absent runtime evidence does not fabricate idle or zero workers', async () => {
  const { service } = await fixture()
  const { workspace } = await service.create({ workspace_id: randomUUID(), name: '测试项目', description: '用途' })
  expect((await service.list()).items).toHaveLength(2)
  const item = (await service.get(workspace.workspace_id)).item
  expect(item.workspace.description).toBe('用途')
  expect(item.usage).toEqual({ status: 'pending', file_count: 0, skipped_entries: 0 })
  expect(item.execution).toEqual({ status: 'unknown' })
  expect(item.directory_status).toBe('ready')
  await fs.rm(workspace.root, { recursive: true })
  expect((await service.get(workspace.workspace_id)).item.directory_status).toBe('missing')
  expect((await service.get('default')).item.directory_status).toBe('missing')
})
it('accepted refresh runs independently, coalesces requests and exposes bounded real metadata results', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let active = 0, peak = 0
  const scan = vi.fn(async () => { active++; peak = Math.max(peak, active); await gate; active--
    return { status: 'complete' as const, logical_bytes: 42, file_count: 1, skipped_entries: 0 } })
  const { service } = await fixture({ scan })
  const a = (await service.create({ workspace_id: randomUUID(), name: 'A' })).workspace
  const b = (await service.create({ workspace_id: randomUUID(), name: 'B' })).workspace
  expect((await service.refresh(a.workspace_id)).usage.status).toBe('measuring')
  await service.refresh(a.workspace_id); await service.refresh(b.workspace_id)
  expect(scan).toHaveBeenCalledTimes(1)
  release()
  expect((await settled(service, a.workspace_id)).logical_bytes).toBe(42)
  expect((await settled(service, b.workspace_id)).logical_bytes).toBe(42)
  expect(peak).toBe(1)
})
it('refresh failure preserves the last measured value as stale; it never becomes a successful zero', async () => {
  const { service } = await fixture()
  const { workspace } = await service.create({ workspace_id: randomUUID(), name: '文件' })
  await fs.writeFile(path.join(workspace.root, '.hidden'), 'abc')
  await service.refresh(workspace.workspace_id)
  expect((await settled(service, workspace.workspace_id)).logical_bytes).toBe(3)
  await fs.rm(workspace.root, { recursive: true })
  await service.refresh(workspace.workspace_id)
  expect(await settled(service, workspace.workspace_id)).toMatchObject({ status: 'stale', logical_bytes: 3 })
})
it('shutdown cancels in-flight and queued scans, waits for owned handles and rejects further work', async () => {
  let cancelled = 0
  const scan = vi.fn(async (_root: string, { signal }: { signal?: AbortSignal } = {}) => {
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => { cancelled++; reject(new Error('aborted')) }, { once: true }))
    return { status: 'complete' as const, file_count: 0, skipped_entries: 0 }
  })
  const { service } = await fixture({ scan })
  const a = (await service.create({ workspace_id: randomUUID(), name: 'A' })).workspace
  const b = (await service.create({ workspace_id: randomUUID(), name: 'B' })).workspace
  await service.refresh(a.workspace_id); await service.refresh(b.workspace_id)
  await service.close()
  expect(cancelled).toBe(1); expect(scan).toHaveBeenCalledTimes(1)
  await expect(service.refresh(a.workspace_id)).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
})
