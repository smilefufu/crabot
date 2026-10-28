import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lookup } from 'node:dns/promises'
import { spawn, execFileSync } from 'node:child_process'
import { TOTAL_BUDGET } from './budget.mjs'
const repo = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(repo, 'package.json'))
const yaml = require('js-yaml')
const mode = process.argv[2]
const image = process.argv[3]
const out = process.env.WORKBUDDY_OUTPUT
if (!['--smoke', '--live'].includes(mode) || !image || !out) throw new Error('Set WORKBUDDY_OUTPUT, then run.mjs <--smoke|--live> <task-image>')
fs.mkdirSync(out, { recursive: false, mode: 0o700 })
const scripted = mode === '--smoke'
const taskId = process.env.WORKBUDDY_TASK_ID ?? 'smoke'
const instruction = scripted ? '请把 /workspace/smoke-answer.txt 写为42并验收交付。已授权在 /workspace 读写与执行。' : '工作目录：/workspace。\n\n' + fs.readFileSync(process.env.WORKBUDDY_INSTRUCTION, 'utf8')
const base = yaml.load(fs.readFileSync(path.join(repo, 'crabot-agent/config.yaml'), 'utf8'))
let stored = {}, modelConfig = { powerful: { endpoint: 'https://example.invalid/v1', apikey: 'scripted-not-a-credential', model_id: 'scripted', format: 'openai' } }
if (!scripted) {
  const data = process.env.REPLAY_DATA_DIR, runtime = process.env.REPLAY_RUNTIME_ROOT
  if (!data || !runtime) throw new Error('REPLAY_DATA_DIR and REPLAY_RUNTIME_ROOT required')
  stored = JSON.parse(fs.readFileSync(path.join(data, 'admin/agent-configs/crabot-agent.json'), 'utf8'))
  const admin = createRequire(path.join(runtime, 'crabot-admin/package.json'))
  const { ModelProviderManager } = admin('./dist/model-provider-manager.js')
  const resolver = new ModelProviderManager(path.join(data, 'admin')); await resolver.initialize()
  modelConfig = {}
  for (const [slot, ref] of Object.entries(stored.model_config)) {
    const conn = await resolver.buildConnectionInfo(ref.provider_id, ref.model_id)
    if (conn.format !== 'openai') throw new Error('This baseline is validated only for current OpenAI-format provider')
    modelConfig[slot] = { ...conn, ...(stored.thinking?.[slot] ?? {}) }
  }
  if (modelConfig.powerful.model_id !== 'gpt-6.1-sol' || modelConfig.powerful.thinking_level !== 'high') throw new Error('Approved model baseline changed')
}
const config = { ...base, module_id: 'eval-agent', port: 0,
  agent_config: { ...stored, instance_id: 'eval-instance', roles: ['front', 'worker'],
    system_prompt: stored.system_prompt ?? '', model_config: modelConfig, mcp_servers: [], subagents: [],
    skills: [{ id: 'tmp-page', name: 'tmp-page', description: '临时页面', skill_dir: '/opt/crabot-eval/skills/tmp-page' }],
  }, runtime_config_authenticated: true,
}
const privateKeys = Object.values(modelConfig).map(c => c.apikey)
const redact = s => privateKeys.reduce((text, key) => text.split(key).join('[REDACTED]'), s)
const name = 'crabot-wb-' + taskId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) + '-' + Date.now()
const timeoutMs = Number(process.env.WORKBUDDY_TIMEOUT_MS ?? (scripted ? 60000 : 3600000))
const args = ['run', '-i', ...(scripted ? [] : ['--platform', 'linux/amd64']), '--name', name, '--network', scripted ? 'none' : 'bridge', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '6g', '--cpus', '2',
  ...(scripted ? [] : ['--cap-add', 'NET_ADMIN', '--cap-add', 'SETPCAP', '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1']),
  '-e', 'DATA_DIR=/eval-data', '-e', 'WORKSPACE_DIR=/workspace', '-e', 'HOME=/eval-home', image,
  'node', '/opt/crabot-eval/runtime.cjs']
if (!scripted) {
  const metadata = JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0]
  if (metadata.Config.Entrypoint?.[0] !== '/opt/crabot-eval/launch.sh') throw new Error('Verified egress entrypoint required')
  const hostname = new URL(modelConfig.powerful.endpoint).hostname
  const addresses = [...new Set((await lookup(hostname, { family: 4, all: true })).map(r => r.address))]
  if (!addresses.length) throw new Error('Provider IPv4 lookup failed')
  args.splice(args.indexOf(image), 0, '-e', 'EVAL_PROVIDER_IPS=' + addresses.join(' '), '--add-host', hostname + ':' + addresses[0])
  fs.writeFileSync(path.join(out, 'execution-plan.json'), JSON.stringify({ taskId, imageId: metadata.Id,
    instructionSha256: createHash('sha256').update(instruction).digest('hex'),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    model: modelConfig.powerful.model_id, thinking: modelConfig.powerful.thinking_level, limit: TOTAL_BUDGET,
    priorTokens: inputUsed(), unknownReserve: Number(process.env.WORKBUDDY_UNKNOWN_RESERVE ?? 0), endpointHost: hostname, egress: addresses,
    differences: ['isolated channel and empty private memory', 'standard tmp-page skill only; no external MCP or child profiles'],
  }, null, 2), { mode: 0o600 })
}
function inputUsed() { return Number(process.env.WORKBUDDY_PRIOR_TOKENS ?? 0) }
const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
const input = { config, taskId, instruction, scripted, scriptedError: process.env.WORKBUDDY_SMOKE_ERROR === '1', timeoutMs, limit: TOTAL_BUDGET, used: inputUsed(), reserved: Number(process.env.WORKBUDDY_UNKNOWN_RESERVE ?? 0) }
child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input))
let buffer = '', result
const log = fs.createWriteStream(path.join(out, 'console.log'), { mode: 0o600 })
child.stdout.on('data', chunk => {
  buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop()
  for (const line of lines) {
    log.write(redact(line) + '\n')
    if (!line.startsWith('CRABOT_EVAL ')) continue
    const row = JSON.parse(line.slice(12))
    if (row.type === 'usage') console.log(JSON.stringify({ taskId, type: row.type, role: row.role, total: row.total, cumulative: row.cumulative }))
    if (row.type === 'result') result = row
    if (row.type === 'fatal') console.error('Evaluation stopped:', row.error)
  }
})
child.stderr.on('data', chunk => log.write(redact(chunk.toString())))
const stopContainer = () => { spawn('docker', ['kill', name], { stdio: 'ignore' }) }
process.once('SIGINT', stopContainer); process.once('SIGTERM', stopContainer)
const watchdog = setTimeout(() => { console.error('Task container timeout'); spawn('docker', ['kill', name]) }, timeoutMs + 20000)
try {
  const exit = await new Promise(resolve => child.on('exit', resolve))
  if (buffer) log.write(redact(buffer))
  fs.writeFileSync(path.join(out, 'host-result.json'), JSON.stringify({ exit, result }, null, 2), { mode: 0o600 })
  execFileSync('docker', ['cp', name + ':/eval-data/.', out], { stdio: 'inherit' })
  execFileSync('docker', ['cp', name + ':/workspace/.', path.join(out, 'workspace')], { stdio: 'inherit' })
  console.log(JSON.stringify({ taskId, exit, status: result?.status, used: result?.used, requests: result?.requests }))
  if (exit || !result || result.status === 'failed' || result.status === 'evaluation_error') process.exitCode = 1
} finally {
  process.removeListener('SIGINT', stopContainer); process.removeListener('SIGTERM', stopContainer)
  clearTimeout(watchdog); log.end(); execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
}
