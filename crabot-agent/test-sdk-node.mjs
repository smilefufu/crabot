/**
 * 独立测试 Node.js Claude Agent SDK query()
 * 用法: node test-sdk-node.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const MODEL = 'provider-9c35d5a3-mercury-2'
const BASE_URL = 'http://localhost:4000'
const API_KEY = 'sk-litellm-test-key-12345'

const options = {
  systemPrompt: 'You are a helpful assistant. Reply briefly.',
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

console.log(`Testing SDK query: model=${MODEL}, base_url=${BASE_URL}`)

try {
  const stream = query({ prompt: 'What is 1+1? Reply with just the number.', options })
  for await (const msg of stream) {
    console.log(`[${msg.type}] subtype=${msg.subtype ?? 'none'}`)
    if (msg.type === 'assistant') {
      console.log(`  message: ${JSON.stringify(msg.message).slice(0, 300)}`)
    }
    if (msg.type === 'result') {
      console.log(`  is_error: ${msg.is_error}`)
      console.log(`  result: ${msg.result}`)
      console.log(`  duration_api_ms: ${msg.duration_api_ms}`)
    }
  }
} catch (e) {
  console.error('Error:', e.message)
}
