import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ModelProviderManager } from './model-provider-manager.js'
import { once } from 'node:events'
import AdminModule from './index.js'
import { HttpClient, ModelClient } from 'crabot-client'

it('desktop model selection reads the formal core model reference endpoint through the real Admin router', async () => {
  const admin = Object.create(AdminModule.prototype) as any
  admin.adminConfig = { web_port: 0 }; admin.jwtSecret = 'unused-fixture'; admin.cutoverActivated = true
  // Authentication is isolated here; actual human/JWT/desktop authority has its
  // own regression suite. This fixture exercises the real routing and DTO.
  admin.verifyAuthenticatedToken = vi.fn(async (token: string) => token === 'fixture-human' ? { sub: 'admin' } : null)
  admin.voiceAdmin = { handleWeb: vi.fn(async () => false) }
  const stored = { model_config: { powerful: { provider_id: 'provider', model_id: 'model', apikey: 'must-not-leave-storage' } } }
  admin.agentManager = { getConfig: vi.fn(() => stored) }
  admin.modelProviderManager = { getGlobalConfig: () => ({}), listProviders: () => [{ id: 'provider', name: 'fixture', status: 'active', models: [{ model_id: 'model', display_name: 'fixture', type: 'llm' }] }] }
  const server = createServer((request, response) => { void admin.handleWebRequest(request, response) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  try {
    const client = new ModelClient(new HttpClient({ endpoint, token: () => 'fixture-human' }))
    expect(await client.hasManagerModel()).toBe(true)
    const result = await fetch(endpoint + '/model-config/agents/crabot-agent', { headers: { Authorization: 'Bearer fixture-human' } })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ config: { agent_id: 'crabot-agent', models: { powerful: { provider_id: 'provider', model_id: 'model' } } } })
    expect(stored.model_config.powerful.apikey).toBe('must-not-leave-storage')
    expect(admin.agentManager.getConfig.mock.calls.every(([id]: [string]) => id === 'crabot-agent')).toBe(true)
    expect((await fetch(endpoint + '/model-config/agents/legacy-other', { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(404)
    expect((await fetch(endpoint + '/model-config/agents/crabot-agent')).status).toBe(401)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})


it('first-run HTTP default selection persists references and reaches both real core model slots without starting MM', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-first-model-http-'))
  const subject = new AdminModule(
    { moduleId: 'admin-web', moduleType: 'admin', version: '0.1.0', protocolVersion: '0.1.0', port: 0, subscriptions: [] },
    { web_port: 0, data_dir: dataDir, password_env: 'UNUSED_FIRST_MODEL_PASSWORD', jwt_secret_env: 'UNUSED_FIRST_MODEL_JWT', token_ttl: 3600 },
  ) as any
  // Only browser and MM identity checks are fixtures. Routing, config storage,
  // durable revisions and native Provider resolution use their actual code.
  subject.verifyAuthenticatedToken = vi.fn(async (token: string) => token === 'fixture-human' ? { sub: 'admin' } : null)
  subject.rpcClient.callModuleManagerSensitive = vi.fn(async (_method: string, _params: unknown, _source: string, context: { authorizationBearer?: string }) => {
    if (context.authorizationBearer !== 'fixture-runtime') throw new Error('invalid fixture identity')
    return { verified: true }
  })
  subject.rpcClient.callModuleManager = vi.fn(async () => ({ module_id: 'crabot-agent', module_type: 'agent', port: 19002 }))
  subject.syncGlobalConfigToMemoryModules = vi.fn(async () => {})
  const providers: ModelProviderManager = subject.modelProviderManager
  const server = createServer((request, response) => { void subject.handleWebRequest(request, response) })
  try {
    await subject.agentManager.initialize()
    await providers.initialize()
    await subject.workerImplementationStore.load()
    await subject.configMutationCoordinator.initialize()
    await subject.agentManager.initializeCoreDefaultsAndMigrations()
    const provider = await providers.createProvider({
      name: 'first model fixture', type: 'manual', format: 'openai', endpoint: 'https://first-model.invalid/v1', api_key: 'fixture-key-private',
      models: [{ model_id: 'first-model', display_name: 'First model', type: 'llm', context_window: 32000 }],
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
    const client = new ModelClient(new HttpClient({ endpoint, token: () => 'fixture-human' }))
    const pull = () => subject.handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'fixture-runtime' })
    expect(await client.hasManagerModel()).toBe(false)
    await expect(pull()).rejects.toMatchObject({ code: 'ADMIN_CORE_AGENT_MODEL_NOT_CONFIGURED' })
    await client.selectDefault({ provider_id: provider.id, model_id: 'first-model' })
    expect(await client.hasManagerModel()).toBe(true)
    expect(JSON.stringify(await client.choices())).not.toContain('fixture-key-private')
    const first = await pull()
    for (const role of ['powerful', 'cost_effective']) {
      expect(first.config.agent_config.model_config[role]).toMatchObject({
        provider_id: provider.id, model_id: 'first-model', endpoint: 'https://first-model.invalid/v1', apikey: 'fixture-key-private', format: 'openai',
      })
    }
    expect(subject.agentManager.getConfig('crabot-agent').model_config).toEqual({})
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'global_model_config.json'), 'utf8'))
    expect(stored.default_llm_provider_id).toBe(provider.id); expect(stored.default_llm_model_id).toBe('first-model')
    expect(JSON.stringify(stored)).not.toMatch(/endpoint|apikey|api_key|fixture-key/)
    await providers.updateProvider(provider.id, { endpoint: 'https://changed-model.invalid/v1', api_key: 'fixture-key-rotated' })
    const second = await pull()
    expect(second.config_revision).toBeGreaterThan(first.config_revision)
    expect(second.config.agent_config.model_config.powerful).toMatchObject({ endpoint: 'https://changed-model.invalid/v1', apikey: 'fixture-key-rotated' })
    const reloaded = new ModelProviderManager(dataDir); await reloaded.initialize()
    expect(await reloaded.resolveModelConfig({ module_id: 'crabot-agent', role: 'llm' })).toMatchObject({
      provider_id: provider.id, model_id: 'first-model', endpoint: 'https://changed-model.invalid/v1', apikey: 'fixture-key-rotated',
    })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await subject.stop().catch(() => {})
    await fs.rm(dataDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  }
})
