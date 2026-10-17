import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
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
