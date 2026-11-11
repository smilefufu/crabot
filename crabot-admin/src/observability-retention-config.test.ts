import { afterEach, beforeEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelProviderManager } from './model-provider-manager'
import { CoreAgentConfigMutationCoordinator } from './core-agent-config-revision-store'
let directory: string
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'retention-config-')) })
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })
it('defaults fresh installations to 30 days', async () => {
  const manager = new ModelProviderManager(directory); await manager.initialize()
  expect(manager.getGlobalConfig().observability_retention_days).toBe(30)
})
it.each([7, 45, 1.5])('migrates %s days without changing other configuration and retires count settings', async days => {
  const file = join(directory, 'global_model_config.json')
  await fs.writeFile(file, JSON.stringify({ trace_retention_days: days, task_retention_count: 100, trace_retention_count: 400,
    default_llm_provider_id: 'saved', public_base_url: 'https://example.test' }))
  const manager = new ModelProviderManager(directory); await manager.initialize()
  expect(manager.getGlobalConfig()).toMatchObject({ observability_retention_days: days, default_llm_provider_id: 'saved' })
  const stored = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const key of ['trace_retention_days', 'task_retention_count', 'trace_retention_count']) expect(stored).not.toHaveProperty(key)
  const restarted = new ModelProviderManager(directory); await restarted.initialize()
  expect(restarted.getGlobalConfig().observability_retention_days).toBe(days)
})
it('prefers the explicit new setting and rejects invalid runtime updates', async () => {
  await fs.writeFile(join(directory, 'global_model_config.json'), JSON.stringify({ observability_retention_days: 12, trace_retention_days: 3 }))
  const manager = new ModelProviderManager(directory); await manager.initialize()
  expect(manager.getGlobalConfig().observability_retention_days).toBe(12)
  for (const value of [0, -1, NaN, Infinity]) await expect(manager.updateGlobalConfig({ observability_retention_days: value })).rejects.toThrow('must be >= 1')
  expect(manager.getGlobalConfig().observability_retention_days).toBe(12)
})

it('preserves an explicitly configured legacy startup retention until an Admin value exists', async () => {
  const previous = process.env.TRACE_RETENTION_DAYS
  try {
    process.env.TRACE_RETENTION_DAYS = '9'
    const manager = new ModelProviderManager(directory); await manager.initialize()
    expect(manager.getGlobalConfig().observability_retention_days).toBe(9)
    await manager.updateGlobalConfig({ observability_retention_days: 45 })
    const restarted = new ModelProviderManager(directory); await restarted.initialize()
    expect(restarted.getGlobalConfig().observability_retention_days).toBe(45)
  } finally {
    if (previous === undefined) delete process.env.TRACE_RETENTION_DAYS
    else process.env.TRACE_RETENTION_DAYS = previous
  }
})

it('publishes a behavior revision on retention changes and treats resetting the default as a no-op', async () => {
  const manager = new ModelProviderManager(directory); await manager.initialize()
  const snapshot = () => ({ retention: manager.getGlobalConfig().observability_retention_days })
  const published: unknown[] = []
  const coordinator = new CoreAgentConfigMutationCoordinator(directory, {
    readSemanticSnapshot: snapshot, publishInvalidation: async value => { published.push(value) },
  })
  manager.setSemanticSnapshotProvider(snapshot)
  manager.setMutationRunner(async (domains, preview, apply, noOp) => {
    await coordinator.mutateComputed(domains, preview, apply, noOp)
  })
  await coordinator.initialize()
  await manager.updateGlobalConfig({ observability_retention_days: 7 })
  expect((await coordinator.current()).revision).toBe(2)
  await manager.updateGlobalConfig({ observability_retention_days: null })
  expect(manager.getGlobalConfig().observability_retention_days).toBe(30)
  expect((await coordinator.current()).revision).toBe(3)
  await manager.updateGlobalConfig({ observability_retention_days: null })
  expect((await coordinator.current()).revision).toBe(3)
  expect(published).toHaveLength(2)
})
