import { query } from '@anthropic-ai/claude-agent-sdk'

// 试用 claude 模型名，看 SDK 是否能正常发请求到 LiteLLM
const MODEL = 'claude-sonnet-4-5-20241022'
const BASE_URL = 'http://localhost:4000'
const API_KEY = 'sk-litellm-test-key-12345'

const options = {
  systemPrompt: 'Reply briefly.',
  model: MODEL,
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_AUTH_TOKEN: API_KEY,
  },
  maxTurns: 1,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  persistSession: false,
  settingSources: [],
  tools: [],
  stderr: (data) => {
    if (data.trim()) console.log(`[stderr] ${data.trim().slice(0, 500)}`)
  },
}

console.log(`Testing with model=${MODEL}`)

try {
  const stream = query({ prompt: '1+1=?', options })
  for await (const msg of stream) {
    console.log(`[${msg.type}] subtype=${msg.subtype ?? 'none'}`)
    if (msg.type === 'assistant') {
      const content = msg.message?.content
      if (content) console.log(`  content: ${JSON.stringify(content).slice(0, 300)}`)
    }
    if (msg.type === 'result') {
      console.log(`  is_error: ${msg.is_error}`)
      console.log(`  result: ${typeof msg.result === 'string' ? msg.result.slice(0, 300) : msg.result}`)
    }
  }
} catch (e) {
  console.error('Error:', e.message)
}
