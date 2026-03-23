import { query } from '@anthropic-ai/claude-agent-sdk'

const options = {
  systemPrompt: 'Reply briefly.',
  model: 'claude-proxy-9c35d5a3-mercury-2',
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
  thinking: { type: 'disabled' },
  pathToClaudeCodeExecutable: '/opt/homebrew/bin/claude',
  stderr: (data) => {
    if (data.trim()) console.log(`[STDERR] ${data.trim().slice(0, 300)}`)
  },
}

console.log(`Testing model=${options.model}`)
try {
  const stream = query({ prompt: '1+1=?', options })
  for await (const msg of stream) {
    if (msg.type === 'result') {
      console.log(`[result] is_error=${msg.is_error} result="${String(msg.result).slice(0,300)}"`)
    } else if (msg.type === 'assistant') {
      const c = msg.message?.content
      if (c) console.log(`[assistant] ${JSON.stringify(c).slice(0,200)}`)
    } else {
      console.log(`[${msg.type}:${msg.subtype ?? '-'}]`)
    }
  }
} catch (e) {
  console.error('Error:', e.message)
}
