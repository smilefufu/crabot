import { query } from '@anthropic-ai/claude-agent-sdk'

const CLI_PATH = new URL('./node_modules/@anthropic-ai/claude-agent-sdk/cli.js', import.meta.url).pathname

const options = {
  systemPrompt: 'Reply with just the number, nothing else.',
  model: 'claude-sonnet-4-5-20241022',
  env: {
    ANTHROPIC_BASE_URL: 'http://localhost:4000',
    ANTHROPIC_API_KEY: 'sk-litellm-test-key-12345',
  },
  maxTurns: 1,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  persistSession: false,
  settingSources: [],
  tools: [],
  pathToClaudeCodeExecutable: CLI_PATH,
  stderr: (data) => {
    if (data.trim()) console.log(`[STDERR] ${data.trim().slice(0, 300)}`)
  },
}

console.log(`CLI: ${CLI_PATH}`)
console.log('Starting test...')
try {
  const stream = query({ prompt: '1+1=?', options })
  for await (const msg of stream) {
    if (msg.type === 'system' && msg.subtype === 'api_retry') {
      console.log(`[api_retry] error_status=${msg.error_status} delay=${msg.delay}`)
    } else if (msg.type === 'result') {
      console.log(`[result] is_error=${msg.is_error} result="${String(msg.result).slice(0,200)}"`)
      if (msg.structured_output) console.log(`  structured: ${JSON.stringify(msg.structured_output).slice(0,200)}`)
    } else if (msg.type === 'assistant') {
      const content = msg.message?.content
      if (content) console.log(`[assistant] ${JSON.stringify(content).slice(0,300)}`)
    } else {
      console.log(`[${msg.type}:${msg.subtype ?? '-'}]`)
    }
  }
  console.log('Done!')
} catch (e) {
  console.error('Error:', e.message)
}
