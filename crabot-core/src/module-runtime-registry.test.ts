import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import {
  ModuleRuntimeRegistry,
  probeProcessStartIdentity,
  probeRuntimeIdentity,
  type OrphanTerminationCandidate,
  type RuntimeIdentity,
  type WindowsPortOwner,
} from './module-runtime-registry.js'

const cleanupDirs: string[] = []
let nextId = 0

function makeRegistry(
  identities: Map<number, string | null>,
  liveTrees: Set<number> = new Set(),
  options: {
    platform?: NodeJS.Platform
    inspectWindowsPortOwners?: (port: number) => Promise<WindowsPortOwner[]>
    probeRuntimeIdentity?: (port: number) => Promise<RuntimeIdentity | null>
    confirmOrphanTermination?: (candidate: OrphanTerminationCandidate) => Promise<boolean>
  } = {},
) {
  nextId += 1
  const dataDir = path.resolve(`test-data/module-runtime-registry-${process.pid}-${nextId}`)
  cleanupDirs.push(dataDir)
  const terminateTree = vi.fn(async () => undefined)
  const registry = new ModuleRuntimeRegistry(dataDir, {
    probeProcessStartIdentity: async pid => identities.get(pid) ?? null,
    isProcessTreeAlive: pid => liveTrees.has(pid),
    terminateProcessTree: terminateTree,
    platform: options.platform,
    inspectWindowsPortOwners: options.inspectWindowsPortOwners,
    probeRuntimeIdentity: options.probeRuntimeIdentity,
    confirmOrphanTermination: options.confirmOrphanTermination,
    createId: vi.fn()
      .mockReturnValueOnce(`instance-${nextId}`)
      .mockReturnValueOnce(`temp-${nextId}-1`)
      .mockReturnValueOnce(`temp-${nextId}-2`)
      .mockReturnValueOnce(`temp-${nextId}-3`),
    now: () => '2026-08-17T00:00:00.000Z',
  })
  return { dataDir, instanceId: `instance-${nextId}`, registry, terminateTree }
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
  it('probes the standard runtime identity RPC envelope', async () => {
    let requestBody: Record<string, unknown> | undefined
    const server = http.createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        requestBody = JSON.parse(body) as Record<string, unknown>
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          id: requestBody.id,
          success: true,
          data: {
            instance_id: 'instance-rpc',
            module_id: 'crabot-agent',
            runtime_id: 'runtime-rpc',
          },
          timestamp: '2026-08-17T00:00:00.000Z',
        }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server')

    try {
      await expect(probeRuntimeIdentity(address.port)).resolves.toEqual({
        instance_id: 'instance-rpc',
        module_id: 'crabot-agent',
        runtime_id: 'runtime-rpc',
      })
      expect(requestBody).toMatchObject({
        source: 'module-manager',
        method: 'get_runtime_identity',
        params: {},
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

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

  it('removes a stale Windows record when a reused root PID has no listener', async () => {
    const identities = new Map<number, string | null>([[401, 'original-start']])
    const inspectWindowsPortOwners = vi.fn(async () => [])
    const { registry, terminateTree } = makeRegistry(identities, new Set(), {
      platform: 'win32',
      inspectWindowsPortOwners,
    })
    await record(registry, 'runtime-reused', 'crabot-agent', 401, 19003)
    identities.set(401, 'replacement-start')

    await registry.recoverOrphans({
      moduleId: 'crabot-agent',
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })

    expect(inspectWindowsPortOwners).toHaveBeenCalledWith(19003)
    expect(terminateTree).not.toHaveBeenCalled()
    expect(await registry.listRecords()).toEqual([])
  })

  it('terminates an exact recorded Windows root without following later port owners', async () => {
    const identities = new Map<number, string | null>([[401, 'original-start']])
    const probeRuntimeIdentity = vi.fn(async () => null)
    const { registry, terminateTree } = makeRegistry(identities, new Set(), {
      platform: 'win32',
      probeRuntimeIdentity,
    })
    await record(registry, 'runtime-exact', 'crabot-agent', 401, 19003)

    await registry.recoverOrphans({
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })

    expect(terminateTree).toHaveBeenCalledWith(401, {
      gracefulTimeoutMs: 30_000,
      requireOwnedProcess: true,
    })
    expect(probeRuntimeIdentity).toHaveBeenCalledWith(19003)
    expect(await registry.listRecords()).toEqual([])
  })

  it('keeps the Windows record and blocks startup if the runtime survives root termination', async () => {
    const identities = new Map<number, string | null>([[401, 'original-start']])
    const expectedInstanceId = `instance-${nextId + 1}`
    const { registry } = makeRegistry(identities, new Set(), {
      platform: 'win32',
      probeRuntimeIdentity: async () => ({
        instance_id: expectedInstanceId,
        module_id: 'crabot-agent',
        runtime_id: 'runtime-exact',
      }),
    })
    await record(registry, 'runtime-exact', 'crabot-agent', 401, 19003)

    await expect(registry.recoverOrphans({
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })).rejects.toThrow('recorded runtime still responds')

    expect((await registry.listRecords()).map(item => item.runtime_id)).toEqual(['runtime-exact'])
  })

  it('fails non-interactive Windows startup with actionable details for a confirmed listener', async () => {
    const identities = new Map<number, string | null>([
      [401, 'original-start'],
      [451, 'listener-start'],
    ])
    const owner: WindowsPortOwner = {
      pid: 451,
      process_name: 'node.exe',
      command_line: 'node dist/main.js',
      process_start_identity: 'listener-start',
    }
    const expectedInstanceId = `instance-${nextId + 1}`
    const { dataDir, registry, terminateTree } = makeRegistry(identities, new Set(), {
      platform: 'win32',
      inspectWindowsPortOwners: async () => [owner],
      probeRuntimeIdentity: async () => ({
        instance_id: expectedInstanceId,
        module_id: 'crabot-agent',
        runtime_id: 'runtime-reused',
      }),
    })
    await record(registry, 'runtime-reused', 'crabot-agent', 401, 19003)
    identities.set(401, 'replacement-start')

    await expect(registry.recoverOrphans({
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })).rejects.toThrow(new RegExp(
      `crabot-agent[\\s\\S]*19003[\\s\\S]*451[\\s\\S]*node\\.exe[\\s\\S]*${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ))

    expect(terminateTree).not.toHaveBeenCalled()
    expect((await registry.listRecords()).map(item => item.runtime_id)).toEqual(['runtime-reused'])
  })

  it('does not prompt or signal when the Windows listener runtime identity does not match', async () => {
    const identities = new Map<number, string | null>([
      [401, 'original-start'],
      [451, 'listener-start'],
    ])
    const confirmOrphanTermination = vi.fn(async () => true)
    const { registry, terminateTree } = makeRegistry(identities, new Set(), {
      platform: 'win32',
      inspectWindowsPortOwners: async () => [{
        pid: 451,
        process_name: 'other.exe',
        command_line: 'other.exe --serve',
        process_start_identity: 'listener-start',
      }],
      probeRuntimeIdentity: async () => ({
        instance_id: 'another-instance',
        module_id: 'crabot-agent',
        runtime_id: 'runtime-reused',
      }),
      confirmOrphanTermination,
    })
    await record(registry, 'runtime-reused', 'crabot-agent', 401, 19003)
    identities.set(401, 'replacement-start')

    await expect(registry.recoverOrphans({
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })).rejects.toThrow('did not prove the recorded runtime identity')

    expect(confirmOrphanTermination).not.toHaveBeenCalled()
    expect(terminateTree).not.toHaveBeenCalled()
    expect((await registry.listRecords()).map(item => item.runtime_id)).toEqual(['runtime-reused'])
  })

  it('does not terminate a confirmed Windows listener when the human declines', async () => {
    const identities = new Map<number, string | null>([
      [401, 'original-start'],
      [451, 'listener-start'],
    ])
    const expectedInstanceId = `instance-${nextId + 1}`
    const confirmOrphanTermination = vi.fn(async () => false)
    const { registry, terminateTree } = makeRegistry(identities, new Set(), {
      platform: 'win32',
      inspectWindowsPortOwners: async () => [{
        pid: 451,
        process_name: 'node.exe',
        command_line: 'node dist/main.js',
        process_start_identity: 'listener-start',
      }],
      probeRuntimeIdentity: async () => ({
        instance_id: expectedInstanceId,
        module_id: 'crabot-agent',
        runtime_id: 'runtime-reused',
      }),
      confirmOrphanTermination,
    })
    await record(registry, 'runtime-reused', 'crabot-agent', 401, 19003)
    identities.set(401, 'replacement-start')

    await expect(registry.recoverOrphans({
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })).rejects.toThrow('termination was not approved')

    expect(confirmOrphanTermination).toHaveBeenCalledOnce()
    expect(terminateTree).not.toHaveBeenCalled()
  })

  it('revalidates and terminates only the confirmed Windows listener PID', async () => {
    const identities = new Map<number, string | null>([
      [401, 'original-start'],
      [451, 'listener-start'],
    ])
    const owner: WindowsPortOwner = {
      pid: 451,
      process_name: 'node.exe',
      command_line: 'node dist/main.js',
      process_start_identity: 'listener-start',
    }
    const expectedInstanceId = `instance-${nextId + 1}`
    const inspectWindowsPortOwners = vi.fn(async () => [owner])
    const probeRuntimeIdentity = vi.fn(async () => ({
      instance_id: expectedInstanceId,
      module_id: 'crabot-agent',
      runtime_id: 'runtime-reused',
    }))
    const confirmOrphanTermination = vi.fn(async () => true)
    const { registry, terminateTree } = makeRegistry(identities, new Set(), {
      platform: 'win32',
      inspectWindowsPortOwners,
      probeRuntimeIdentity,
      confirmOrphanTermination,
    })
    await record(registry, 'runtime-reused', 'crabot-agent', 401, 19003)
    identities.set(401, 'replacement-start')

    await registry.recoverOrphans({
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })

    expect(inspectWindowsPortOwners).toHaveBeenCalledTimes(2)
    expect(probeRuntimeIdentity).toHaveBeenCalledTimes(2)
    expect(confirmOrphanTermination).toHaveBeenCalledOnce()
    expect(terminateTree).toHaveBeenCalledWith(451, {
      gracefulTimeoutMs: 30_000,
      requireOwnedProcess: true,
    })
    expect(await registry.listRecords()).toEqual([])
  })

  it('does not signal when the Windows listener changes during confirmation', async () => {
    const identities = new Map<number, string | null>([
      [401, 'original-start'],
      [451, 'listener-start'],
      [452, 'new-listener-start'],
    ])
    const expectedInstanceId = `instance-${nextId + 1}`
    const inspectWindowsPortOwners = vi.fn()
      .mockResolvedValueOnce([{
        pid: 451,
        process_name: 'node.exe',
        command_line: 'node dist/main.js',
        process_start_identity: 'listener-start',
      }])
      .mockResolvedValueOnce([{
        pid: 452,
        process_name: 'other.exe',
        command_line: 'other.exe --serve',
        process_start_identity: 'new-listener-start',
      }])
    const { registry, terminateTree } = makeRegistry(identities, new Set(), {
      platform: 'win32',
      inspectWindowsPortOwners,
      probeRuntimeIdentity: async () => ({
        instance_id: expectedInstanceId,
        module_id: 'crabot-agent',
        runtime_id: 'runtime-reused',
      }),
      confirmOrphanTermination: async () => true,
    })
    await record(registry, 'runtime-reused', 'crabot-agent', 401, 19003)
    identities.set(401, 'replacement-start')

    await expect(registry.recoverOrphans({
      currentRuntimeIds: new Set(),
      gracefulTimeoutMs: 30_000,
    })).rejects.toThrow('changed during confirmation')

    expect(terminateTree).not.toHaveBeenCalled()
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
