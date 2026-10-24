// CI-only preparation through the unchanged SDK/HTTP configuration boundary.
// This creates a local fake Provider; it never submits a chat or generation.
async function configurePairedSourceModel(host, endpoint) {
  let stage = 'context'
  const fail = () => { throw Object.assign(new Error('Paired source model setup failed: ' + stage), { code: 'PAIRED_SOURCE_MODEL_SETUP' }) }
  try {
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d*\/v1$/.test(endpoint)) fail()
    const providerUrl = new URL(endpoint)
    if (Number(providerUrl.port) > 65535 || host.snapshot().phase !== 'ready') fail()
    const credential = await host.credential()
    if (!credential) fail()
    const admin = new URL(credential.admin_url)
    if (admin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(admin.hostname)) fail()
    const current = () => {
      const context = host.context()
      return host.snapshot().phase === 'ready' && context && ['instance_id', 'generation', 'admin_url', 'connection_epoch'].every(key => context[key] === credential[key])
    }
    if (!current()) fail()
    const { HttpClient, ModelClient, z } = await import('crabot-client')
    const http = new HttpClient({ endpoint: new URL('/api', admin).href, token: () => { if (!current()) fail(); return credential.token } })
    const models = new ModelClient(http)
    stage = 'initial-config'
    const before = await models.globalConfig()
    if (before.config.default_llm_provider_id || before.config.default_llm_model_id || !current()) fail()
    stage = 'create-provider'
    const model_id = 'desktop-paired-update'
    const provider = await http.request('/model-providers', z.object({ id: z.string().min(1).max(128) }), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: 'Isolated paired update source', type: 'manual', format: 'openai', endpoint, api_key: 'paired-update-fixture',
        models: [{ model_id, display_name: 'Paired update fixture', type: 'llm', context_window: 128000 }],
      }),
    })
    if (!current()) fail()
    stage = 'select-default'
    await models.selectDefault({ provider_id: provider.id, model_id })
    if (!current()) fail()
    stage = 'verify-reference'
    const after = await models.globalConfig()
    if (!current() || after.config.default_llm_provider_id !== provider.id || after.config.default_llm_model_id !== model_id) fail()
    return { configured_via_http: true, provider_id: provider.id, model_id }
  } catch { fail() } // Server bodies and the human credential never enter fixture reports.
}
module.exports = { configurePairedSourceModel }
