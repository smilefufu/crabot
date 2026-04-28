#!/usr/bin/env node
// scripts/replay-front-trace.mjs — replay Front trace samples with new prompt
//
// 抽 5 条 Front message trace，提取 trace 里 llm_call.full_input（完整 user message），
// 用新版 PromptManager 生成 system prompt，调用现成 default provider 重跑一次，
// 对比新决策与原决策是否一致。

import fs from 'node:fs'
import path from 'node:path'

import { PromptManager } from '../crabot-agent/dist/prompt-manager.js'
import {
  REPLY_TOOL,
  CREATE_TASK_TOOL,
  STAY_SILENT_TOOL,
} from '../crabot-agent/dist/agent/front-tools.js'

// ── 配置 ──
const TRACE_PREFIXES = ['ce04691f', '44556372', '15a0ea1c', 'f7d0c026', '60262946']
const PROVIDER_ID_PREFIX = '0f213d72'
const MODEL = 'glm-5'

// ── 读 provider ──
const providers = JSON.parse(fs.readFileSync('data/admin/model_providers.json', 'utf8'))
const allProviders = Array.isArray(providers) ? providers : Object.values(providers)
const provider = allProviders.find(p => p?.id?.startsWith(PROVIDER_ID_PREFIX))
if (!provider) {
  console.error(`Provider ${PROVIDER_ID_PREFIX} not found`)
  process.exit(1)
}
const apiKey = provider.api_key
const endpoint = provider.endpoint
console.log(`[replay] provider=${provider.name} endpoint=${endpoint} model=${MODEL}\n`)

// ── 抽 trace ──
const traces = []
const traceDir = 'data/agent/traces'
for (const f of fs.readdirSync(traceDir).sort()) {
  if (!f.startsWith('traces-2026-04')) continue
  const lines = fs.readFileSync(path.join(traceDir, f), 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    const t = JSON.parse(line)
    if (TRACE_PREFIXES.some(prefix => t.trace_id?.startsWith(prefix))) {
      traces.push(t)
    }
  }
}
console.log(`[replay] matched ${traces.length} traces from ${TRACE_PREFIXES.length} prefixes\n`)

// ── PromptManager ──
const pm = new PromptManager()

// ── 主循环 ──
const results = []
for (const t of traces) {
  const traceId = t.trace_id.slice(0, 8)
  const trigger = t.trigger?.summary ?? ''
  const llmSpan = t.spans?.find(s => s.type === 'llm_call')
  const userMsg = llmSpan?.details?.full_input
  const decisionSpan = t.spans?.find(s => s.type === 'decision')
  const originalDecision = decisionSpan?.details?.decision_type ?? '<unknown>'

  if (!userMsg || typeof userMsg !== 'string') {
    console.log(`⏭  ${traceId}: 跳过（无 full_input 或非字符串）`)
    results.push({ traceId, original: originalDecision, replay: 'SKIPPED', match: null })
    continue
  }

  const isGroup = userMsg.includes('会话类型: 群聊')
  const systemPrompt = pm.assembleFrontPrompt({ isGroup })

  // 工具定义（无活跃任务 → 不传 supplement_task）
  const tools = [
    { name: REPLY_TOOL.name, description: REPLY_TOOL.description, input_schema: REPLY_TOOL.inputSchema },
    { name: CREATE_TASK_TOOL.name, description: CREATE_TASK_TOOL.description, input_schema: CREATE_TASK_TOOL.inputSchema },
  ]
  if (isGroup) {
    tools.push({ name: STAY_SILENT_TOOL.name, description: STAY_SILENT_TOOL.description, input_schema: STAY_SILENT_TOOL.inputSchema })
  }

  // 调 anthropic-format API
  let newDecision = '<error>'
  let errorMsg = null
  try {
    const url = `${endpoint}/v1/messages`
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
        tools,
        tool_choice: { type: 'any' },
      }),
    })
    if (!resp.ok) {
      errorMsg = `HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`
    } else {
      const result = await resp.json()
      const toolUse = result.content?.find(c => c.type === 'tool_use')
      if (toolUse) {
        newDecision = toolUse.name
      } else {
        errorMsg = `no tool_use; stop_reason=${result.stop_reason}`
      }
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err)
  }

  // 决策类型映射（原 trace decision_type ←→ 新 tool name）
  const mapped = {
    reply: 'direct_reply',
    create_task: 'create_task',
    supplement_task: 'supplement_task',
    stay_silent: 'silent',
  }[newDecision] ?? newDecision

  const matched = mapped === originalDecision
  const status = errorMsg ? '⚠️ ' : matched ? '✅' : '❌'
  console.log(`${status} ${traceId} | scene=${isGroup ? 'group' : 'private'} | original=${originalDecision} replay=${mapped} ${errorMsg ? `| err=${errorMsg}` : ''}`)
  console.log(`   trigger: ${trigger.slice(0, 80)}`)

  results.push({ traceId, isGroup, original: originalDecision, replay: mapped, match: matched, error: errorMsg })
}

// ── 汇总 ──
console.log('\n=== 汇总 ===')
const total = results.length
const errored = results.filter(r => r.error).length
const matched = results.filter(r => r.match === true).length
const mismatched = results.filter(r => r.match === false).length
console.log(`Total: ${total}`)
console.log(`✅ 一致: ${matched}`)
console.log(`❌ 不一致: ${mismatched}`)
console.log(`⚠️  错误: ${errored}`)
if (total > errored) {
  const rate = (matched / (total - errored) * 100).toFixed(1)
  console.log(`一致率（剔除 error）: ${rate}%`)
}
