import { query } from '@anthropic-ai/claude-agent-sdk'

// 直接测试原始的 provider-xxx 模型名
const tests = [
  'provider-9c35d5a3-mercury-2',
  'claude-proxy-9c35d5a3-mercury-2',
]

for (const model of tests) {
  console.log(`\n=== Testing: ${model} ===`)
  try {
    const stream = query({
      prompt: '1+1=?',
      options: {
        systemPrompt: 'Reply with just the number.',
        model,
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
      }
    })
    for await (const msg of stream) {
      if (msg.type === 'result') {
        console.log(`  is_error=${msg.is_error}, result="${String(msg.result).slice(0,100)}"`)
      } else if (msg.type === 'assistant') {
        const text = msg.message?.content?.find(b => b.type === 'text')?.text
        if (text) console.log(`  response: "${text}"`)
      }
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }
}
