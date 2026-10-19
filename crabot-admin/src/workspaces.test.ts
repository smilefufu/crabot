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
  expect((await service.get('default')).item.directory_status).toBe('ready')
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

it('one inventory read covers the complete list; only a ready complete empty binding is idle', async () => {
  const execution = vi.fn(async () => ({ ready: true, items: { default: { status: 'running' as const, worker_count: 2 } } }))
  const { service } = await fixture({ execution })
  const project = (await service.create({ workspace_id: randomUUID(), name: '项目' })).workspace
  const result = await service.list()
  expect(execution).toHaveBeenCalledTimes(1)
  expect(result.items.find(item => item.workspace.workspace_id === 'default')!.execution).toMatchObject({ status: 'running', worker_count: 2 })
  expect(result.items.find(item => item.workspace.workspace_id === project.workspace_id)!.execution).toMatchObject({ status: 'idle', worker_count: 0 })
  execution.mockResolvedValueOnce({ ready: false, items: {} } as never)
  expect((await service.list()).items.every(item => item.execution.status === 'unknown' && item.execution.worker_count === undefined)).toBe(true)
  execution.mockRejectedValueOnce(new Error('agent unreachable'))
  expect((await service.list()).items.every(item => item.execution.status === 'unknown')).toBe(true)
})

it('aggregate statistics use one union of registered roots, not a sum of project totals', async () => {
  const { root, service } = await fixture()
  const parent = path.join(root, 'workspaces', 'parent'), nested = path.join(parent, 'nested')
  await fs.mkdir(nested, { recursive: true })
  await fs.writeFile(path.join(nested, 'one'), Buffer.alloc(19))
  await service.create({ workspace_id: randomUUID(), name: 'parent', root: parent })
  await service.create({ workspace_id: randomUUID(), name: 'nested', root: nested })
  expect((await service.totalUsage()).status).toBe('pending')
  expect((await service.refreshTotalUsage()).status).toBe('measuring')
  await vi.waitFor(async () => expect(await service.totalUsage()).toMatchObject({ status: 'complete', logical_bytes: 19, file_count: 1 }))
  const snapshot = await service.list()
  await service.update(snapshot.items[1].workspace.workspace_id, { expected_revision: snapshot.revision, name: 'renamed', description: '' })
  expect((await service.totalUsage()).logical_bytes).toBe(19)
  await service.create({ workspace_id: randomUUID(), name: 'another' })
  expect((await service.totalUsage()).status).toBe('pending')
})
it('a superseded aggregate scan cannot publish the old root set; aggregate requests coalesce with bounded concurrency', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const scanSet = vi.fn(async () => { await gate; return { status: 'complete' as const, logical_bytes: 87, file_count: 1, skipped_entries: 0 } })
  const { service } = await fixture({ scanSet })
  await service.refreshTotalUsage(); await service.refreshTotalUsage()
  expect(scanSet).toHaveBeenCalledTimes(1)
  await service.create({ workspace_id: randomUUID(), name: 'new scope' })
  release()
  await service.close()
  expect((await service.totalUsage()).status).toBe('pending')
  await expect(service.refreshTotalUsage()).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
})

it('project and aggregate scans share one serial queue and aggregate cancellation closes owned work', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const scan = vi.fn(async () => { await gate; return { status: 'complete' as const, file_count: 0, skipped_entries: 0 } })
  let aborted = false
  const scanSet = vi.fn(async (_roots: readonly string[], { signal }: { signal?: AbortSignal } = {}) => {
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')) }, { once: true }))
    return { status: 'complete' as const, file_count: 0, skipped_entries: 0 }
  })
  const { service } = await fixture({ scan, scanSet })
  await service.refresh('default'); await service.refreshTotalUsage()
  expect(scan).toHaveBeenCalledTimes(1); expect(scanSet).not.toHaveBeenCalled()
  release()
  await vi.waitFor(() => expect(scanSet).toHaveBeenCalledTimes(1))
  await service.close()
  expect(aborted).toBe(true); expect((await service.totalUsage()).status).toBe('failed')
})

it('maintenance pauses only scan access, drains owned handles, keeps management readable and resumes on explicit release', async () => {
  let release!: () => void, closed = false, started!: () => void
  const seen = new Promise<void>(resolve => { started = resolve })
  const handleGate = new Promise<void>(resolve => { release = resolve })
  const scan = vi.fn(async (_root: string, { signal }: { signal?: AbortSignal } = {}) => {
    if (scan.mock.calls.length > 1) return { status: 'complete' as const, logical_bytes: 23, file_count: 1, skipped_entries: 0 }
    const handle = await fs.open(path.join(_root, 'open-file'), 'w')
    try {
      started()
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      return { status: 'complete' as const, file_count: 0, skipped_entries: 0 }
    } finally { await handleGate; await handle.close(); closed = true }
  })
  const { service } = await fixture({ scan })
  await service.refresh('default'); await seen
  let pause: Promise<void> | undefined
  try {
    pause = service.pauseScanning()
    await expect(service.refresh('default')).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    await expect(service.refreshTotalUsage()).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    expect(() => service.resumeScanning()).toThrow()
    expect((await service.list()).items).toHaveLength(1); expect(closed).toBe(false)
  } finally { release(); await pause }
  expect(closed).toBe(true)
  expect((await service.usage('default')).usage.status).toBe('failed')
  service.resumeScanning(); await service.refresh('default')
  expect((await settled(service, 'default')).logical_bytes).toBe(23)
  await service.close()
  expect(() => service.resumeScanning()).toThrow()
})
