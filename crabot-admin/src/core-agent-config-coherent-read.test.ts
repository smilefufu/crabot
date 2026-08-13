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
    { moduleId: 'admin-web', moduleType: 'admin', version: '0.1.0', protocolVersion: '0.1.0', port: 0, subscriptions: [] },
    { web_port: 0, data_dir: dataDir, password_env: 'UNUSED_CONFIG_READ_PASSWORD', jwt_secret_env: 'UNUSED_CONFIG_READ_JWT', token_ttl: 3600 },
  )
  return { admin, dataDir }
}

describe('core Agent config pull authorization', () => {
  it('does not register the retired credential-returning resolve_model_config RPC', () => {
    const subject = Object.create(AdminModule.prototype) as any
    expect(subject.methodHandlers?.has?.('resolve_model_config') ?? false).toBe(false)
    expect((AdminModule.prototype as any).handleResolveModelConfig).toBeUndefined()
  })

  it('does not treat a forged Request source as identity or touch secret resolvers without a bearer', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.rpcClient = { callModuleManagerSensitive: vi.fn() }
    subject.modelProviderManager = { buildConnectionInfo: vi.fn(), resolveModelConfig: vi.fn() }

    await expect(subject.handleGetAgentConfig({
      instance_id: 'crabot-agent',
      source: 'crabot-agent',
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    expect(subject.rpcClient.callModuleManagerSensitive).not.toHaveBeenCalled()
    expect(subject.modelProviderManager.resolveModelConfig).not.toHaveBeenCalled()
    expect(subject.modelProviderManager.buildConnectionInfo).not.toHaveBeenCalled()
  })

  it('rejects an invalid bearer through MM verification before resolving Provider credentials', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.config = { moduleId: 'test-admin' }
    subject.rpcClient = {
      callModuleManagerSensitive: vi.fn().mockRejectedValue(Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' })),
    }
    subject.modelProviderManager = { buildConnectionInfo: vi.fn(), resolveModelConfig: vi.fn() }

    await expect(subject.handleGetAgentConfig(
      { instance_id: 'crabot-agent' },
      { authorizationBearer: 'forged-runtime-token' },
    )).rejects.toThrow('FORBIDDEN')

    expect(subject.rpcClient.callModuleManagerSensitive).toHaveBeenCalledWith(
      'verify_core_agent_runtime',
      { expected_module_id: 'crabot-agent' },
      'test-admin',
      { authorizationBearer: 'forged-runtime-token' },
    )
    expect(subject.modelProviderManager.resolveModelConfig).not.toHaveBeenCalled()
    expect(subject.modelProviderManager.buildConnectionInfo).not.toHaveBeenCalled()
  })
})

describe('core Agent config coherent reads', () => {
  const resources: Array<{ admin: AdminModule; dataDir: string }> = []
  afterEach(async () => {
    vi.restoreAllMocks()
    while (resources.length) {
      const { admin, dataDir } = resources.pop()!
      await admin.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('retries after a concurrent revision change and returns only the matching resolved config', async () => {
    const resource = await makeAdmin(); resources.push(resource)
    const subject = resource.admin as any
    subject.rpcClient.callModuleManagerSensitive = vi.fn().mockResolvedValue({ verified: true })
    subject.rpcClient.callModuleManager = vi.fn().mockResolvedValue({ module_id: 'crabot-agent', module_type: 'agent', port: 19002 })
    subject.agentManager.configs.set('crabot-agent', { instance_id: 'crabot-agent', model_config: { powerful: { provider_id: 'p', model_id: 'm' } } })
    const epochs = [
      { revision: 1, generation: 0 },
      { revision: 2, generation: 2 },
      { revision: 2, generation: 2 },
      { revision: 2, generation: 2 },
    ]
    subject.configMutationCoordinator.readCommittedEpoch = vi.fn(async () => epochs.shift() ?? { revision: 2, generation: 2 })
    subject.modelProviderManager.resolveModelConfig = vi.fn().mockResolvedValue(null)
    subject.modelProviderManager.buildConnectionInfo = vi.fn().mockResolvedValue({ endpoint: 'https://new.example', apikey: 'new', model_id: 'm', format: 'openai', provider_id: 'p' })
    subject.modelProviderManager.resolveImageConfig = vi.fn().mockResolvedValue({ available: false, reason: 'none' })
    subject.mcpServerManager.list = vi.fn().mockReturnValue([])
    subject.skillManager.list = vi.fn().mockReturnValue([])
    subject.subAgentManager.listEnabled = vi.fn().mockReturnValue([])
    const result = await subject.handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })
    expect(result.config_revision).toBe(2)
    expect(result.config.agent_config.model_config.powerful).toMatchObject({ endpoint: 'https://new.example', apikey: 'new' })
    expect(result.config).not.toHaveProperty('essential_tools')
  })

  it('does not return source-written config under the prior revision while coordinator outbox is active', async () => {
    const resource = await makeAdmin(); resources.push(resource)
    const subject = resource.admin as any
    subject.rpcClient.callModuleManagerSensitive = vi.fn().mockResolvedValue({ verified: true })
    subject.rpcClient.callModuleManager = vi.fn().mockResolvedValue({ module_id: 'crabot-agent', module_type: 'agent', port: 19002 })
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
    const guardedRead = read.catch((error: unknown) => { throw error })
    release.resolve()
    await mutation
    const result = await guardedRead
    expect(result.config_revision).toBe(2)
    expect(result.config.agent_config.model_config.powerful).toMatchObject({ model_id: 'new', endpoint: 'https://new.example' })
    await fs.rm(coordinatorDir, { recursive: true, force: true })
  })

  it('fails closed after bounded concurrent changes instead of returning a mixed revision', async () => {
    const resource = await makeAdmin(); resources.push(resource)
    const subject = resource.admin as any
    subject.rpcClient.callModuleManagerSensitive = vi.fn().mockResolvedValue({ verified: true })
    subject.rpcClient.callModuleManager = vi.fn().mockResolvedValue({ module_id: 'crabot-agent', module_type: 'agent', port: 19002 })
    subject.agentManager.configs.set('crabot-agent', { instance_id: 'crabot-agent', model_config: {} })
    let revision = 0
    subject.configMutationCoordinator.readCommittedEpoch = vi.fn(async () => ({ revision: ++revision, generation: revision * 2 }))
    subject.modelProviderManager.resolveModelConfig = vi.fn().mockResolvedValue({
      endpoint: 'https://default.example', apikey: 'default', model_id: 'default', format: 'openai', provider_id: 'p',
    })
    subject.modelProviderManager.resolveImageConfig = vi.fn().mockResolvedValue({ available: false, reason: 'none' })
    subject.mcpServerManager.list = vi.fn().mockReturnValue([])
    subject.skillManager.list = vi.fn().mockReturnValue([])
    subject.subAgentManager.listEnabled = vi.fn().mockReturnValue([])
    await expect(subject.handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })).rejects.toThrow('retry later')
  })
})
