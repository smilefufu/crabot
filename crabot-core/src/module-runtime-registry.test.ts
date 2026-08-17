import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ModuleRuntimeRegistry, probeProcessStartIdentity } from './module-runtime-registry.js'

const cleanupDirs: string[] = []
let nextId = 0

function makeRegistry(
  identities: Map<number, string | null>,
  liveTrees: Set<number> = new Set(),
) {
  nextId += 1
  const dataDir = path.resolve(`test-data/module-runtime-registry-${process.pid}-${nextId}`)
  cleanupDirs.push(dataDir)
  const terminateTree = vi.fn(async () => undefined)
  const registry = new ModuleRuntimeRegistry(dataDir, {
    probeProcessStartIdentity: async pid => identities.get(pid) ?? null,
    isProcessTreeAlive: pid => liveTrees.has(pid),
    terminateProcessTree: terminateTree,
    createId: vi.fn()
      .mockReturnValueOnce(`instance-${nextId}`)
      .mockReturnValueOnce(`temp-${nextId}-1`)
      .mockReturnValueOnce(`temp-${nextId}-2`)
      .mockReturnValueOnce(`temp-${nextId}-3`),
    now: () => '2026-08-17T00:00:00.000Z',
  })
  return { dataDir, registry, terminateTree }
}

async function record(
  registry: ModuleRuntimeRegistry,
  runtimeId: string,
  moduleId: string,
  rootPid: number,
  modulePort: number,
): Promise<void> {
  await registry.recordSpawn({ runtimeId, moduleId, rootPid, modulePort })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanupDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('ModuleRuntimeRegistry', () => {
  it('captures a stable identity for the current process', async () => {
    const first = await probeProcessStartIdentity(process.pid)
    const second = await probeProcessStartIdentity(process.pid)

    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('reports a PID with no live process as absent', async () => {
    expect(await probeProcessStartIdentity(2_147_483_647)).toBeNull()
  })

  it('recovers every stale runtime for one module before replacement', async () => {
    const identities = new Map<number, string | null>([
      [101, 'start-101'],
      [102, 'start-102'],
    ])
    const { registry, terminateTree } = makeRegistry(identities)
    await record(registry, 'runtime-a', 'crabot-agent', 101, 19003)
    await record(registry, 'runtime-b', 'crabot-agent', 102, 19003)

    await registry.recoverOrphans({
      moduleId: 'crabot-agent',
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })

    expect(terminateTree).toHaveBeenCalledTimes(2)
    expect(terminateTree).toHaveBeenNthCalledWith(1, 101, expect.objectContaining({
      gracefulTimeoutMs: 30_000,
      modulePort: 19003,
      requireOwnedProcess: true,
    }))
    expect(terminateTree).toHaveBeenNthCalledWith(2, 102, expect.objectContaining({
      gracefulTimeoutMs: 30_000,
      modulePort: 19003,
      requireOwnedProcess: true,
    }))
    expect(await registry.listRecords()).toEqual([])
  })

  it('preserves a runtime owned by the current MM', async () => {
    const identities = new Map<number, string | null>([[201, 'start-201']])
    const { registry, terminateTree } = makeRegistry(identities)
    await record(registry, 'runtime-current', 'memory-default', 201, 19004)

    await registry.recoverOrphans({
      moduleId: 'memory-default',
      currentRuntimeIds: new Set(['runtime-current']),
      gracefulTimeoutMs: 30_000,
    })

    expect(terminateTree).not.toHaveBeenCalled()
    expect((await registry.listRecords()).map(item => item.runtime_id)).toEqual(['runtime-current'])
  })

  it('ignores runtime records belonging to another Crabot instance', async () => {
    const identities = new Map<number, string | null>([[251, 'start-251']])
    const { dataDir, registry, terminateTree } = makeRegistry(identities)
    await record(registry, 'runtime-foreign', 'memory-default', 251, 19004)
    const recordPath = path.join(dataDir, 'module-runtime-registry', 'records', 'runtime-foreign.json')
    const stored = JSON.parse(await fs.readFile(recordPath, 'utf8')) as { instance_id: string }
    stored.instance_id = 'another-instance'
    await fs.writeFile(recordPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')

    await registry.recoverOrphans({
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })

    expect(terminateTree).not.toHaveBeenCalled()
    expect((await registry.listRecords()).map(item => item.runtime_id)).toEqual(['runtime-foreign'])
  })

  it('removes a dead runtime record without signalling another process', async () => {
    const identities = new Map<number, string | null>([[301, 'start-301']])
    const { registry, terminateTree } = makeRegistry(identities)
    await record(registry, 'runtime-dead', 'feishu-default', 301, 19005)
    identities.set(301, null)

    await registry.recoverOrphans({
      moduleId: 'feishu-default',
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })

    expect(terminateTree).not.toHaveBeenCalled()
    expect(await registry.listRecords()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('recovers a recorded POSIX process group after its root exits', async () => {
    const identities = new Map<number, string | null>([[351, 'start-351']])
    const liveTrees = new Set<number>()
    const { registry, terminateTree } = makeRegistry(identities, liveTrees)
    await record(registry, 'runtime-descendants', 'memory-default', 351, 19004)
    identities.set(351, null)
    liveTrees.add(351)

    await registry.recoverOrphans({
      moduleId: 'memory-default',
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })

    expect(terminateTree).toHaveBeenCalledWith(351, expect.objectContaining({
      gracefulTimeoutMs: 30_000,
      modulePort: 19004,
      requireOwnedProcess: true,
    }))
    expect(await registry.listRecords()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('removes a stale POSIX runtime record when its root PID has been reused', async () => {
    const identities = new Map<number, string | null>([[401, 'original-start']])
    const { registry, terminateTree } = makeRegistry(identities)
    await record(registry, 'runtime-reused', 'crabot-agent', 401, 19003)
    identities.set(401, 'replacement-start')

    await registry.recoverOrphans({
      moduleId: 'crabot-agent',
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })

    expect(terminateTree).not.toHaveBeenCalled()
    expect(await registry.listRecords()).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('does not signal a reused Windows PID and refuses orphan recovery', async () => {
    const identities = new Map<number, string | null>([[401, 'original-start']])
    const { registry, terminateTree } = makeRegistry(identities)
    await record(registry, 'runtime-reused', 'crabot-agent', 401, 19003)
    identities.set(401, 'replacement-start')

    await expect(registry.recoverOrphans({
      moduleId: 'crabot-agent',
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })).rejects.toThrow('process start identity changed')

    expect(terminateTree).not.toHaveBeenCalled()
    expect((await registry.listRecords()).map(item => item.runtime_id)).toEqual(['runtime-reused'])
  })

  it('removes only the exact runtime record named by a finalizer', async () => {
    const identities = new Map<number, string | null>([
      [501, 'start-old'],
      [502, 'start-replacement'],
    ])
    const { registry } = makeRegistry(identities)
    await record(registry, 'runtime-old', 'crabot-agent', 501, 19003)
    await record(registry, 'runtime-replacement', 'crabot-agent', 502, 19003)

    await registry.removeRuntime('runtime-old')

    expect((await registry.listRecords()).map(item => item.runtime_id)).toEqual(['runtime-replacement'])
  })
})
