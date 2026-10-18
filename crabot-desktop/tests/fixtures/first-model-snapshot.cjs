// Serialized into the isolated synthetic renderer after a failed first reply.
// Only counts/enums leave this function: never prompts, API keys or error text.
module.exports = async function firstModelSnapshot() {
  const state = await window.crabotDesktop.getState()
  const summary = { phase: state.phase, visible_users: document.querySelectorAll('[data-msg-role="user"]').length,
    visible_assistants: document.querySelectorAll('[data-msg-role="assistant"]').length, draft_present: Boolean(document.querySelector('textarea')?.value) }
  if (state.phase !== 'ready') return summary
  const read = async relative => {
    try {
      const response = await fetch(new URL(relative, state.admin_url).href, { signal: AbortSignal.timeout(2000) })
      return { status: response.status, value: response.ok ? await response.json() : null }
    } catch { return { status: 0, value: null } }
  }
  const [history, managers, episodes] = await Promise.all([
    read('/api/chat/messages?limit=20'), read('/api/agent/managers?page=1&page_size=20'),
    read('/api/agent/managers/admin-web%3A%3Aadmin-chat/episodes?page=1&page_size=20'),
  ])
  const messages = Array.isArray(history.value?.messages) ? history.value.messages : []
  const inputs = messages.filter(message => message.role === 'user')
  const manager = managers.value?.items?.find(item => item.manager_key === 'admin-web::admin-chat')
  const items = Array.isArray(episodes.value?.items) ? episodes.value.items : []
  return { ...summary, history_status: history.status, stored_inputs: inputs.length,
    acknowledged_inputs: inputs.filter(message => message.request_id && message.acknowledged_at).length,
    stored_replies: messages.filter(message => message.role === 'assistant').length,
    manager_status: managers.status, manager_present: Boolean(manager),
    manager_execution: ['running', 'idle', 'unknown'].includes(manager?.execution_status) ? manager.execution_status : 'unavailable',
    episodes_status: episodes.status, episodes: items.slice(0, 20).map(item => ({
      status: ['running', 'completed', 'failed'].includes(item.status) ? item.status : 'unknown',
      span_counts: Object.fromEntries(['context_assembly', 'llm_call', 'tool_call'].map(type => [type, (item.spans ?? []).filter(span => span.type === type).length])),
    })) }
}
