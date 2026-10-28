// Executed only through the development full-host harness. Product auth, SDK,
// HTTP/WS, React handlers and business runtime are never replaced.
module.exports = async function firstModel(window, endpoint) {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/v1$/.test(endpoint)) throw new Error('First-model fixture requires loopback')
  const create = async function (endpoint) {
    const state = await window.crabotDesktop.getState()
    if (state.phase !== 'ready') throw Error('Desktop session unavailable')
    const api = relative => new URL(relative, state.admin_url).href
    const config = await fetch(api('/api/model-config/global')).then(response => { if (!response.ok) throw Error('Initial model config unavailable'); return response.json() })
    if (config.config.default_llm_provider_id || config.config.default_llm_model_id) throw Error('First-run fixture is already configured')
    const response = await fetch(api('/api/model-providers'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: 'Isolated desktop first model', type: 'manual', format: 'openai', endpoint, api_key: 'isolated-first-model-fixture',
      models: [{ model_id: 'desktop-first-model', display_name: 'Desktop first model', type: 'llm', context_window: 128000 }],
    }) })
    if (response.status !== 201) throw Error('First model provider was not created')
    const provider = await response.json()
    return provider.id
  }
  const providerId = await window.webContents.executeJavaScript('(' + create.toString() + ')(' + JSON.stringify(endpoint) + ')')
  await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload() })
  const converse = async function (providerId) {
    const state = await window.crabotDesktop.getState()
    if (state.phase !== 'ready') throw Error('Desktop session unavailable')
    const api = relative => new URL(relative, state.admin_url).href
    const wait = async (description, read) => {
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
      throw Error('First-model UI timed out: ' + description)
    }
    const button = text => [...document.querySelectorAll('button')].find(value => value.textContent?.trim() === text && !value.disabled)
    const save = await wait('default model selection', () => button('保存并开始聊天'))
    save.click()
    const input = await wait('connected chat', () => document.querySelector('textarea:not(:disabled)'))
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'CI首次对话\n请在当前桌面会话回复预定的测试内容。')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const send = await wait('enabled send action', () => button('发送'))
    send.click()
    const reply = '桌面首次对话链路已连通。'
    await wait('visible delivered reply', () => [...document.querySelectorAll('[data-msg-role="assistant"]')].some(element => element.textContent.includes(reply)))
    await wait('durable delivery and input acknowledgement', async () => {
      const history = await fetch(api('/api/chat/messages?limit=20')).then(response => { if (!response.ok) throw Error('History unavailable'); return response.json() })
      const user = history.messages.find(message => message.role === 'user' && message.content.text === 'CI首次对话\n请在当前桌面会话回复预定的测试内容。')
      const assistant = history.messages.find(message => message.role === 'assistant' && message.content.text === reply)
      return user?.request_id && user.acknowledged_at && assistant?.delivery_id
    })
    const stored = await fetch(api('/api/model-config/global')).then(response => response.json())
    if (stored.config.default_llm_provider_id !== providerId || stored.config.default_llm_model_id !== 'desktop-first-model') throw Error('Default reference changed')
    if (localStorage.getItem('crabot_admin_token')) throw Error('Renderer persisted a desktop credential')
    return { provider_created_via_http: true, default_selected_via_ui: true, chat_submitted_via_ui: true, visible_reply: true,
      durable_delivery: true, durable_input_ack: true, renderer_token_absent: true, model_substitute: true, remote_model_verified: false }
  }
  try { return await window.webContents.executeJavaScript('(' + converse.toString() + ')(' + JSON.stringify(providerId) + ')') }
  catch (error) {
    try {
      const snapshot = await window.webContents.executeJavaScript('(' + require('./first-model-snapshot.cjs').toString() + ')()')
      error.message += '\nFirst-model snapshot: ' + JSON.stringify(snapshot)
    } catch {}
    throw error
  }
}
