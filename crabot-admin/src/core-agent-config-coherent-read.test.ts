import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CoreAgentConfigMutationCoordinator } from './core-agent-config-revision-store.js'
import AdminModule from './index.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function makeAdmin(): Promise<{ admin: AdminModule; dataDir: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-admin-config-read-'))
  const admin = new AdminModule(
    { moduleId: 'admin-web', moduleType: 'admin', version: '0.1.0', protocolVersion: '0.1.0', port: 19971, subscriptions: [] },
    { web_port: 19972, data_dir: dataDir, password_env: 'UNUSED_CONFIG_READ_PASSWORD', jwt_secret_env: 'UNUSED_CONFIG_READ_JWT', token_ttl: 3600 },
  )
  await admin.start()
  return { admin, dataDir }
}

describe('core Agent config coherent reads', () => {
  const resources: Array<{ admin: AdminModule; dataDir: string }> = []
  afterEach(async () => {
    vi.restoreAllMocks()
    while (resources.length) {
      const { admin, dataDir } = resources.pop()!
      await admin.stop()
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('retries after a concurrent revision change and returns only the matching resolved config', async () => {
    const resource = await makeAdmin(); resources.push(resource)
    const subject = resource.admin as any
    subject.rpcClient.callModuleManagerSensitive = vi.fn().mockResolvedValue({ verified: true })
    subject.agentManager.configs.set('crabot-agent', { instance_id: 'crabot-agent', model_config: { powerful: { provider_id: 'p', model_id: 'm' } } })
    let reads = 0
    subject.configMutationCoordinator.current = vi.fn(async () => ({ revision: reads++ === 0 ? 1 : 2 }))
    subject.modelProviderManager.resolveModelConfig = vi.fn().mockResolvedValue(null)
    subject.modelProviderManager.buildConnectionInfo = vi.fn().mockResolvedValue({ endpoint: 'https://new.example', apikey: 'new', model_id: 'm', format: 'openai', provider_id: 'p' })
    subject.modelProviderManager.resolveImageConfig = vi.fn().mockResolvedValue({ available: false, reason: 'none' })
    subject.mcpServerManager.list = vi.fn().mockReturnValue([])
    subject.skillManager.list = vi.fn().mockReturnValue([])
    subject.subAgentManager.listEnabled = vi.fn().mockReturnValue([])
    const result = await subject.handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })
    expect(result.config_revision).toBe(2)
    expect(result.config.model_config.powerful).toMatchObject({ endpoint: 'https://new.example', apikey: 'new' })
  })

  it('does not return source-written config under the prior revision while coordinator outbox is active', async () => {
    const resource = await makeAdmin(); resources.push(resource)
    const subject = resource.admin as any
    subject.rpcClient.callModuleManagerSensitive = vi.fn().mockResolvedValue({ verified: true })
    const source = { model: 'old' }
    subject.agentManager.getConfig = vi.fn(() => ({ instance_id: 'crabot-agent', model_config: { powerful: { provider_id: 'p', model_id: source.model } } }))
    subject.modelProviderManager.resolveModelConfig = vi.fn().mockResolvedValue(null)
    subject.modelProviderManager.buildConnectionInfo = vi.fn(async (_provider: string, model: string) => ({ endpoint: `https://${model}.example`, apikey: model, model_id: model, format: 'openai', provider_id: 'p' }))
    subject.modelProviderManager.resolveImageConfig = vi.fn().mockResolvedValue({ available: false, reason: 'none' })
    subject.mcpServerManager.list = vi.fn().mockReturnValue([])
    subject.skillManager.list = vi.fn().mockReturnValue([])
    subject.subAgentManager.listEnabled = vi.fn().mockReturnValue([])

    const written = deferred<void>()
    const release = deferred<void>()
    const coordinatorDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-admin-config-epoch-'))
    const coordinator = new CoreAgentConfigMutationCoordinator(coordinatorDir, {
      readSemanticSnapshot: () => ({ model: source.model }),
      publishInvalidation: () => {},
      hooks: { afterSourceMutation: async () => { written.resolve(); await release.promise } },
    })
    await coordinator.initialize()
    subject.configMutationCoordinator = coordinator
    const mutation = coordinator.mutate(['models'], { model: 'new' }, async () => {
      source.model = 'new'
    })
    await written.promise
    const read = subject.handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    release.resolve()
    await mutation
    const result = await read
    expect(result.config_revision).toBe(2)
    expect(result.config.model_config.powerful).toMatchObject({ model_id: 'new', endpoint: 'https://new.example' })
    await fs.rm(coordinatorDir, { recursive: true, force: true })
  })

  it('fails closed after bounded concurrent changes instead of returning a mixed revision', async () => {
    const resource = await makeAdmin(); resources.push(resource)
    const subject = resource.admin as any
    subject.rpcClient.callModuleManagerSensitive = vi.fn().mockResolvedValue({ verified: true })
    subject.agentManager.configs.set('crabot-agent', { instance_id: 'crabot-agent', model_config: {} })
    let revision = 0
    subject.configMutationCoordinator.readCommittedEpoch = vi.fn(async () => ++revision)
    subject.modelProviderManager.resolveModelConfig = vi.fn().mockResolvedValue(null)
    subject.modelProviderManager.resolveImageConfig = vi.fn().mockResolvedValue({ available: false, reason: 'none' })
    subject.mcpServerManager.list = vi.fn().mockReturnValue([])
    subject.skillManager.list = vi.fn().mockReturnValue([])
    subject.subAgentManager.listEnabled = vi.fn().mockReturnValue([])
    await expect(subject.handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })).rejects.toThrow('retry later')
  })
})
