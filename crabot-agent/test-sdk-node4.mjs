import { query } from '@anthropic-ai/claude-agent-sdk'

const options = {
  systemPrompt: 'Reply briefly.',
  model: 'claude-sonnet-4-5-20241022',
  env: {
    ANTHROPIC_BASE_URL: 'http://localhost:4000',
    ANTHROPIC_API_KEY: 'sk-litellm-test-key-12345',
    ANTHROPIC_AUTH_TOKEN: 'sk-litellm-test-key-12345',
  },
  maxTurns: 1,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  persistSession: false,
  settingSources: [],
  tools: [],
  stderr: (data) => {
    if (data.trim()) console.log(`[STDERR] ${data.trim().slice(0, 800)}`)
  },
}

console.log('Starting test...')
const stream = query({ prompt: 'say hello', options })
for await (const msg of stream) {
  if (msg.type === 'system' && msg.subtype === 'api_retry') {
    console.log(`[api_retry] ${JSON.stringify(msg).slice(0, 500)}`)
  } else if (msg.type === 'result') {
    console.log(`[result] is_error=${msg.is_error} result=${String(msg.result).slice(0,300)}`)
  } else {
    console.log(`[${msg.type}:${msg.subtype ?? '-'}]`)
  }
}
