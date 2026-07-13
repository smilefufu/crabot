#!/usr/bin/env node
// =============================================================================
// Crabot Agent 调试脚本
//
// 封装常用调试 RPC 查询，适用于所有 Agent 模块实现
// 详细用法说明：crabot-docs/guides/agent-debugging.md
// =============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ── 端口配置 ──────────────────────────────────────────────────────────────────

const PORTS = {
  mm: parseInt(process.env.CRABOT_MM_PORT ?? '19000'),
  admin: process.env.CRABOT_ADMIN_PORT ? parseInt(process.env.CRABOT_ADMIN_PORT) : null,
  agent: process.env.CRABOT_AGENT_PORT ? parseInt(process.env.CRABOT_AGENT_PORT) : null,
}

// ── 颜色 ──────────────────────────────────────────────────────────────────────

const c = {
  red: (s) => `\x1b[0;31m${s}\x1b[0m`,
  green: (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
  blue: (s) => `\x1b[0;34m${s}\x1b[0m`,
  cyan: (s) => `\x1b[0;36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
}

// ── 基础工具 ──────────────────────────────────────────────────────────────────

async function rpcCall(port, method, params = {}) {
  if (!port) return null
  const body = {
    id: `dbg-${Date.now()}`,
    source: 'debug',
    method,
    params,
    timestamp: new Date().toISOString(),
  }
  try {
    const res = await fetch(`http://localhost:${port}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return null
  }
}

async function isHealthy(port) {
  const res = await rpcCall(port, 'health')
  return res?.success ? res : null
}

function pickModulePort(modules, matcher) {
  const mod = modules.find((m) => m?.port && matcher(m))
  return mod?.port ?? null
}

async function findHealthyPort(candidates) {
  for (const port of candidates) {
    if (await isHealthy(port)) return port
  }
  return null
}

async function resolveModulePorts() {
  const envAdmin = PORTS.admin != null
  const envAgent = PORTS.agent != null
  if (PORTS.admin && PORTS.agent) return PORTS

  const list = await rpcCall(PORTS.mm, 'list_modules')
  const modules = list?.success ? (list.data?.modules ?? []) : []
  if (modules.length > 0) {
    if (!PORTS.admin) {
      PORTS.admin = pickModulePort(
        modules,
        (m) => m.module_type === 'admin' || m.module_id === 'admin-web' || m.module_id === 'crabot-admin',
      )
    }
    if (!PORTS.agent) {
      PORTS.agent = pickModulePort(
        modules,
        (m) => m.module_type === 'agent' || m.module_id === 'crabot-agent',
      )
    }
  }

  if (!PORTS.admin) {
    const resolved = await rpcCall(PORTS.mm, 'resolve', { module_type: 'admin' })
    PORTS.admin = resolved?.success ? pickModulePort(resolved.data?.modules ?? [], (m) => Boolean(m.port)) : null
  }
  if (!PORTS.agent) {
    const resolved = await rpcCall(PORTS.mm, 'resolve', { module_type: 'agent' })
    PORTS.agent = resolved?.success ? pickModulePort(resolved.data?.modules ?? [], (m) => Boolean(m.port)) : null
  }

  if (!PORTS.admin && !envAdmin) PORTS.admin = await findHealthyPort([19002, 19001])
  if (!PORTS.agent && !envAgent) PORTS.agent = await findHealthyPort([19003, 19005])

  PORTS.admin ??= 19001
  PORTS.agent ??= 19005
  return PORTS
}

function formatDuration(ms) {
  if (ms == null) return 'running'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`
}

function statusColor(status) {
  switch (status) {
    case 'running': return c.blue(status)
    case 'completed': return c.green(status)
    case 'failed': return c.red(status)
    default: return status
  }
}

function pad(s, len) {
  return (s ?? '').toString().padEnd(len)
}

function short(id, len = 8) {
  return (id ?? '--------').slice(0, len)
}

/**
 * 根据前缀解析完整 trace_id。
 * 支持短 ID 前缀匹配（如 traces 列表中显示的 8 字符 ID）。
 */
async function resolveTraceId(prefix) {
  await resolveModulePorts()
  if (!prefix) return null

  // 先精确查找
  const exact = await rpcCall(PORTS.agent, 'get_trace', { trace_id: prefix })
  if (exact?.success) return prefix

  // 前缀匹配：拉取最近的 trace 列表进行匹配
  const list = await rpcCall(PORTS.agent, 'get_traces', { limit: 100 })
  if (!list?.success) return null

  const matches = list.data.traces.filter((t) => t.trace_id.startsWith(prefix))
  if (matches.length === 1) return matches[0].trace_id
  if (matches.length > 1) {
    console.log(c.yellow(`[warn] 前缀 "${prefix}" 匹配到 ${matches.length} 条 trace，请提供更长的前缀：`))
    for (const t of matches) {
      console.log(`  ${c.dim(short(t.trace_id, 12))}  ${t.status}  ${t.trigger?.summary?.slice(0, 60) ?? ''}`)
    }
    return null
  }
  return null
}

// =============================================================================
// 命令：health
// =============================================================================

async function cmdHealth() {
  await resolveModulePorts()
  console.log(`${c.bold(c.cyan('── Module Health ──'))}\n`)

  const modules = [
    ['Module Manager', PORTS.mm],
    ['Admin (RPC)', PORTS.admin],
    ['Agent', PORTS.agent],
  ]

  await Promise.all(
    modules.map(async ([name, port]) => {
      const res = await rpcCall(port, 'health')
      if (res?.success) {
        const status = res.data?.status ?? 'unknown'
        const colorFn = status === 'healthy' ? c.green : status === 'degraded' ? c.yellow : c.red
        console.log(`  ${colorFn('●')} ${name} (port ${port}): ${colorFn(status)}`)
      } else {
        console.log(`  ${c.red('●')} ${name} (port ${port}): ${c.red('unreachable')}`)
      }
    }),
  )
  console.log()
}

// =============================================================================
// 命令：traces
// =============================================================================

async function cmdTraces(limit = 10, statusFilter) {
  await resolveModulePorts()
  const params = { limit }
  if (statusFilter) params.status = statusFilter

  const res = await rpcCall(PORTS.agent, 'get_traces', params)
  if (!res?.success) {
    console.log(`${c.red('[error]')} Agent (port ${PORTS.agent}) 无响应，或返回格式错误`)
    if (res) console.log(JSON.stringify(res, null, 2))
    return
  }

  const { traces, total } = res.data
  console.log(`${c.bold(c.cyan(`── Traces (最近 ${limit}/${total} 条) ──`))}\n`)

  for (const t of traces) {
    const tid = c.dim(short(t.trace_id))
    const dur = formatDuration(t.duration_ms)
    const ttype = t.trigger?.type ?? ''
    const summary = (t.trigger?.summary ?? '').slice(0, 60)
    console.log(`  ${tid}  ${pad(statusColor(t.status), 22)}  ${pad(dur, 8)}  ${pad(ttype, 10)}  ${summary}`)

    const outcome = (t.outcome?.summary ?? '').slice(0, 80)
    if (outcome) {
      console.log(`              ${c.dim(`→ ${outcome}`)}`)
    }
  }
  console.log()
}

// =============================================================================
// 命令：trace
// =============================================================================

async function cmdTrace(traceIdArg) {
  await resolveModulePorts()
  let traceId = traceIdArg

  if (!traceId) {
    const list = await rpcCall(PORTS.agent, 'get_traces', { limit: 1 })
    traceId = list?.data?.traces?.[0]?.trace_id
    if (!traceId) {
      console.log(`${c.red('[error]')} 没有 trace，或 Agent 无响应`)
      return
    }
    console.log(c.dim(`(使用最新 trace: ${traceId})`))
  } else {
    const resolved = await resolveTraceId(traceId)
    if (!resolved) {
      console.log(`${c.red('[error]')} 找不到匹配前缀 "${traceId}" 的 trace`)
      return
    }
    if (resolved !== traceId) {
      console.log(c.dim(`(匹配到完整 ID: ${resolved})`))
    }
    traceId = resolved
  }

  const res = await rpcCall(PORTS.agent, 'get_trace', { trace_id: traceId })
  if (!res?.success) {
    console.log(`${c.red('[error]')} 获取 trace ${traceId} 失败`)
    if (res) console.log(JSON.stringify(res, null, 2))
    return
  }

  const trace = res.data.trace ?? res.data

  console.log(`\n${c.bold(c.cyan('── Trace Detail ──'))}`)
  console.log(`  ID:      ${c.bold(traceId)}`)
  console.log(`  Status:  ${statusColor(trace.status)}  (${formatDuration(trace.duration_ms)})`)
  console.log(`  Trigger: [${trace.trigger?.type}] ${trace.trigger?.summary ?? ''}`)
  if (trace.trigger?.source) console.log(`  Source:  ${trace.trigger.source}`)

  const outcome = trace.outcome?.summary
  const outcomeErr = trace.outcome?.error
  if (outcome) console.log(`  Outcome: ${c.green(outcome)}`)
  if (outcomeErr) console.log(`  Error:   ${c.red(outcomeErr)}`)

  console.log(`\n${c.bold('  Spans:')}`)

  for (const span of trace.spans ?? []) {
    const sid = c.dim(short(span.span_id))
    const psid = c.dim(short(span.parent_span_id))
    const dur = formatDuration(span.duration_ms)
    const d = span.details ?? {}

    let detail = ''
    switch (span.type) {
      case 'llm_call':
        detail = `iter=${d.iteration} | ${(d.input_summary ?? '').slice(0, 60)}`
        break
      case 'tool_call':
        detail = `${d.tool_name}: ${(d.input_summary ?? '').slice(0, 50)}`
        break
      case 'decision':
        detail = `${d.decision_type}: ${(d.summary ?? '').slice(0, 60)}`
        break
      case 'context_assembly':
        detail = `${d.context_type} ctx, session=${short(d.session_id)}`
        break
      case 'rpc_call':
        detail = `${d.target_module ?? '?'}:${d.method} [${d.status_code ?? '?'}]`
        break
      case 'dispatch_call': {
        const parts = []
        if (d.model) parts.push(`model=${d.model}`)
        if (d.session_type) parts.push(`session=${d.session_type}`)
        if (d.message_count != null) parts.push(`msgs=${d.message_count}`)
        if (d.action_count != null) parts.push(c.cyan(`actions=${d.action_count}`))
        if (d.retries) parts.push(c.yellow(`retries=${d.retries}`))
        if (d.error) parts.push(c.red(`err=${d.error.slice(0, 60)}`))
        detail = parts.join(' | ')
        break
      }
      case 'dispatch_action': {
        const kind = d.kind ?? '?'
        const kindLabel = kind === 'supplement' ? c.blue(kind)
          : kind === 'new_task' ? c.green(kind)
          : kind === 'stay_silent' ? c.dim(kind)
          : kind
        const parts = [kindLabel]
        if (d.immediate_reply_sent === true) parts.push(c.cyan('dispatcher_ack=sent'))
        if (d.immediate_reply_sent === false) parts.push(c.dim('dispatcher_ack=none'))
        if (d.outcome === 'supplement_delivered') parts.push(c.blue('supplement_ack=delivered_to_worker'))
        if (d.outcome === 'terminal_task_revived') parts.push(c.blue('supplement_ack=revived_worker'))
        if (d.outcome === 'supplement_fallback_recovered') parts.push(c.yellow('supplement_ack=fallback_new_task'))
        if (d.target_task_id) parts.push(`task=${short(d.target_task_id)}`)
        if (d.text_summary) parts.push(`"${String(d.text_summary).slice(0, 50)}"`)
        if (d.reason) parts.push(`reason=${String(d.reason).slice(0, 40)}`)
        if (d.spawned_trace_id) parts.push(`→trace=${short(d.spawned_trace_id)}`)
        detail = parts.join(' | ')
        break
      }
      default:
        detail = JSON.stringify(span).slice(0, 60)
    }

    console.log(`    ${sid}<-${psid}  ${pad(span.type, 20)}  ${pad(statusColor(span.status), 22)}  ${pad(dur, 8)}  ${detail}`)
  }
  console.log()
}

// =============================================================================
// 命令：tasks
// =============================================================================

async function cmdTasks(statusFilter) {
  await resolveModulePorts()
  const params = {
    page: 1,
    page_size: 20,
    sort: { field: 'created_at', order: 'desc' },
  }
  if (statusFilter) params.filter = { status: statusFilter }

  const res = await rpcCall(PORTS.admin, 'list_tasks', params)
  if (!res?.success) {
    console.log(`${c.red('[error]')} Admin (port ${PORTS.admin}) 无响应`)
    if (res) console.log(JSON.stringify(res, null, 2))
    return
  }

  const tasks = res.data?.items ?? []
  const total = res.data?.pagination?.total_items ?? tasks.length
  console.log(`${c.bold(c.cyan(`── Tasks (${total} 条) ──`))}\n`)

  for (const t of tasks) {
    const tid = c.dim(short(t.id ?? t.task_id))
    const title = (t.title ?? '').slice(0, 50)
    const created = (t.created_at ?? '').slice(0, 19)
    console.log(`  ${tid}  ${pad(statusColor(t.status), 24)}  ${pad(t.type ?? t.task_type, 12)}  ${pad(t.priority, 8)}  ${title}  ${c.dim(created)}`)
  }
  console.log()
}

// =============================================================================
// 命令：logs
// =============================================================================

function cmdLogs(lines = 50) {
  const home = process.env.CRABOT_HOME ?? PROJECT_ROOT
  const logFile = resolve(home, 'data/worker-handler-debug.log')

  console.log(`${c.bold(c.cyan(`── Worker Handler Log (最近 ${lines} 行) ──`))}`)
  console.log(`${c.dim(`  ${logFile}`)}\n`)

  if (!existsSync(logFile)) {
    console.log(c.yellow(`  日志文件不存在: ${logFile}`))
    console.log(c.dim('  提示：Agent 需要运行过至少一次才会生成日志'))
    console.log()
    return
  }

  try {
    const content = readFileSync(logFile, 'utf-8')
    const allLines = content.trimEnd().split('\n')
    const tail = allLines.slice(-lines)
    console.log(tail.join('\n'))
  } catch (err) {
    console.log(c.red(`  读取日志失败: ${err.message}`))
  }
  console.log()
}

// =============================================================================
// 命令：modules
// =============================================================================

async function cmdModules() {
  await resolveModulePorts()
  const res = await rpcCall(PORTS.mm, 'list_modules')

  console.log(`${c.bold(c.cyan('── Registered Modules ──'))}\n`)

  if (!res?.success) {
    console.log(`${c.red('[error]')} Module Manager 无响应或不支持 list_modules`)
    if (res) console.log(JSON.stringify(res, null, 2))
    console.log()
    return
  }

  for (const m of res.data?.modules ?? []) {
    console.log(`  ${m.module_id}  type=${m.module_type}  port=${m.port ?? '?'}  status=${m.status ?? '?'}`)
  }
  console.log()
}

// =============================================================================
// 命令：watch
// =============================================================================

async function cmdWatch() {
  console.log(c.dim('监控模式，每 3 秒刷新。Ctrl+C 退出。'))

  while (true) {
    console.clear()
    console.log(c.dim(new Date().toLocaleString()))
    await cmdHealth()
    await cmdTraces(5)
    await new Promise((r) => setTimeout(r, 3000))
  }
}

// =============================================================================
// 命令：help
// =============================================================================

function cmdHelp() {
  const name = 'scripts/debug-agent.mjs'
  console.log(`
${c.bold('Crabot Agent 调试脚本')}

  ${c.bold('用法:')} node ${name} <命令> [参数...]

  ${c.bold('命令:')}
    ${c.cyan('traces')}  [limit] [status]   列出最近的 Trace（默认 10 条）
    ${c.cyan('trace')}   [trace_id]          显示单个 Trace 详情（支持短 ID 前缀）
    ${c.cyan('tasks')}   [status]            列出 Admin 任务
    ${c.cyan('health')}                      检查各模块健康状态
    ${c.cyan('logs')}    [lines]             查看 Worker Handler 日志（默认 50 行）
    ${c.cyan('modules')}                     列出 MM 注册的模块
    ${c.cyan('watch')}                       实时监控模式

  ${c.bold('环境变量（覆盖默认端口）:')}
    CRABOT_MM_PORT    Module Manager 端口（默认 19000）
    CRABOT_ADMIN_PORT Admin RPC 端口（默认 19001）
    CRABOT_AGENT_PORT Agent 端口（默认 19005）

  ${c.bold('示例:')}
    node ${name} traces              # 列出最近 10 条 trace
    node ${name} traces 20 failed    # 列出最近 20 条失败的 trace
    node ${name} trace               # 显示最新 trace 详情
    node ${name} trace cbb0cd63      # 用短 ID 前缀查看 trace
    node ${name} tasks executing     # 列出进行中的任务
    node ${name} logs 100            # 查看最近 100 行日志

  ${c.dim(`详细说明：crabot-docs/guides/agent-debugging.md`)}
`)
}

// =============================================================================
// 入口
// =============================================================================

const [cmd, ...args] = process.argv.slice(2)

switch (cmd) {
  case 'health':
    await cmdHealth()
    break
  case 'traces':
    await cmdTraces(parseInt(args[0]) || 10, args[1])
    break
  case 'trace':
    await cmdTrace(args[0])
    break
  case 'tasks':
    await cmdTasks(args[0])
    break
  case 'logs':
    cmdLogs(parseInt(args[0]) || 50)
    break
  case 'modules':
    await cmdModules()
    break
  case 'watch':
    await cmdWatch()
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    cmdHelp()
    break
  default:
    console.log(`${c.red('[error]')} 未知命令: ${cmd}`)
    cmdHelp()
    process.exit(1)
}
