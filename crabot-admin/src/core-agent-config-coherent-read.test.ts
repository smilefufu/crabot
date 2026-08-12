import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdminModule from './index.js'

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

  it('fails closed after bounded concurrent changes instead of returning a mixed revision', async () => {
    const resource = await makeAdmin(); resources.push(resource)
    const subject = resource.admin as any
    subject.rpcClient.callModuleManagerSensitive = vi.fn().mockResolvedValue({ verified: true })
    subject.agentManager.configs.set('crabot-agent', { instance_id: 'crabot-agent', model_config: {} })
    let revision = 0
    subject.configMutationCoordinator.current = vi.fn(async () => ({ revision: ++revision }))
    subject.modelProviderManager.resolveModelConfig = vi.fn().mockResolvedValue(null)
    subject.modelProviderManager.resolveImageConfig = vi.fn().mockResolvedValue({ available: false, reason: 'none' })
    subject.mcpServerManager.list = vi.fn().mockReturnValue([])
    subject.skillManager.list = vi.fn().mockReturnValue([])
    subject.subAgentManager.listEnabled = vi.fn().mockReturnValue([])
    await expect(subject.handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })).rejects.toThrow('retry later')
  })
})
