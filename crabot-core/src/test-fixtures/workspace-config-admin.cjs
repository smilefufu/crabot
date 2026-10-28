// Finite config transport for isolated CI. It does not exercise Admin provider resolution.
function handleWorkspaceConfigRequest(request, response, { config, moduleManagerPort }) {
  if (request.url.startsWith('/v1/')) {
    response.writeHead(503); response.end('No model request is allowed during workspace validation')
    return true
  }
  if (request.url !== '/get_agent_config') return false
  void (async () => {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CRABOT_WORKSPACE_BUSINESS_ONSTART_CI !== '1' || request.method !== 'POST') throw new Error('Isolated CI only')
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new Error('Missing runtime')
    let text = ''
    for await (const part of request) { text += part; if (text.length > 65536) throw new Error('Config request too large') }
    const body = JSON.parse(text)
    if (body.method !== 'get_agent_config' || JSON.stringify(body.params) !== JSON.stringify({ instance_id: 'crabot-agent' })) throw new Error('Unexpected config request')
    const verified = await fetch('http://127.0.0.1:' + moduleManagerPort + '/verify_core_agent_runtime', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ id: body.id, source: 'admin-web', method: 'verify_core_agent_runtime', params: { expected_module_id: 'crabot-agent' } }),
      signal: AbortSignal.timeout(5000),
    })
    if (!(await verified.json()).success) throw new Error('Wrong runtime')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ id: body.id, success: true, data: { config, config_revision: 1 } }))
  })().catch(() => {
    if (!response.headersSent) response.writeHead(503)
    response.end(JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Isolated configuration unavailable' } }))
  })
  return true
}
module.exports = { handleWorkspaceConfigRequest }
