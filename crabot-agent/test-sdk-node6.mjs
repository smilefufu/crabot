import { query } from '@anthropic-ai/claude-agent-sdk'

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
  // 用全局 claude 命令作为可执行文件
  pathToClaudeCodeExecutable: '/opt/homebrew/bin/claude',
  stderr: (data) => {
    if (data.trim()) console.log(`[STDERR] ${data.trim().slice(0, 300)}`)
  },
}

console.log('Starting with /opt/homebrew/bin/claude ...')
try {
  const stream = query({ prompt: '1+1=?', options })
  for await (const msg of stream) {
    if (msg.type === 'system' && msg.subtype === 'api_retry') {
      console.log(`[api_retry] status=${msg.error_status} delay=${msg.delay}s`)
    } else if (msg.type === 'result') {
      console.log(`[result] is_error=${msg.is_error} result="${String(msg.result).slice(0,300)}"`)
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
