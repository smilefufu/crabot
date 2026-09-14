import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { repo, requireAgent, connection, hash } from './runtime.mjs'

const impl = process.argv[2]
assert(['builtin', 'claude-code', 'codex'].includes(impl))
assert(process.env.REPLAY_OUTPUT_DIR)
const out = path.resolve(process.env.REPLAY_OUTPUT_DIR)
await fs.mkdir(out, { recursive: true })
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `crabot-behavior-${impl}-`)))
const workspace = path.join(root, 'project')
const dataDir = path.join(root, 'workers')
await fs.mkdir(workspace)
process.env.DATA_DIR = path.join(root, 'data')
delete process.env.CRABOT_AGENT_DATA_DIR
const append = async value => fs.appendFile(path.join(out, `${impl}.jsonl`), JSON.stringify(value) + '\n', { mode: 0o600 })
const served = []
const server = http.createServer((req, res) => {
  served.push({ url: req.url, at: new Date().toISOString() })
  res.writeHead(req.url === '/input' ? 200 : 404, { 'content-type': 'application/json' })
  res.end(JSON.stringify(req.url === '/input' ? [2, 4, 6] : { error: 'not found' }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/input`
const rules = '# Project\n\nThis disposable project uses report.mjs to generate report.json from endpoint.txt. Keep all input rows. Update relevant documentation with verified facts. No commit, push or deployment is requested.\n'
const script = "import fs from 'node:fs/promises'\nconst url = (await fs.readFile('endpoint.txt', 'utf8')).trim()\nconst response = await fetch(url)\nif (!response.ok) throw new Error(`HTTP ${response.status}`)\nconst rows = await response.json()\nawait fs.writeFile('report.json', JSON.stringify({count: rows.length, total: rows.reduce((a,b)=>a+b,0)})+'\\n')\nconsole.log('report written')\n"
for (const [name, text] of Object.entries({ 'AGENTS.md': rules, 'README.md': '# Report\n\nRun `node report.mjs`.\n', 'report.mjs': script, 'endpoint.txt': endpoint + '\n', '.gitignore': 'report.json\n.claude/\n.codex/\n.mcp.json\n' })) {
  await fs.writeFile(path.join(workspace, name), text)
}
execFileSync('git', ['init', '-q'], { cwd: workspace })
execFileSync('git', ['add', '.'], { cwd: workspace })
execFileSync('git', ['-c', 'user.name=Crabot Eval', '-c', 'user.email=eval@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Isolated fixture'], { cwd: workspace })
const skills = ['tmp-page', 'workspace-context-maintenance'].map(name => ({
  id: name, name, description: name === 'workspace-context-maintenance' ? '按任务读取和维护项目文档，遵循项目约定' : '临时页面',
  skill_dir: path.join(repo, name === 'tmp-page' ? 'crabot-admin/builtins/skills' : 'crabot-admin/builtin-skills', name),
}))
const { captureWorkspaceInstructions } = requireAgent('./dist/workers/harness/workspace-instructions.js')
let agent
let adapter
let handle
let cleanupError
const traceWrites = []
const trace = value => { traceWrites.push(append(value)) }
try {
  if (impl === 'builtin') {
    const conn = await connection()
    const { UnifiedAgent } = requireAgent('./dist/unified-agent.js')
    agent = new UnifiedAgent({
      module_id: 'isolated-eval', module_type: 'agent', version: '0.0.0', protocol_version: '1.0', port: 19998,
      orchestration: {
        front_context_recent_messages_window_hours: 24, front_context_recent_messages_max_cap: 50,
        front_context_short_term_memory_window_hours: 24, front_context_short_term_memory_max_cap: 20,
        worker_recent_messages_window_hours: 24, worker_recent_messages_max_cap: 50,
        worker_short_term_memory_window_hours: 24, worker_short_term_memory_max_cap: 20,
        worker_long_term_memory_limit: 10, front_agent_timeout: 60, session_state_ttl: 3600,
        worker_config_refresh_interval: 300, front_agent_queue_max_length: 10, front_agent_queue_timeout: 60,
      },
      agent_config: { instance_id: 'isolated-eval', roles: ['worker'], system_prompt: '', model_config: { powerful: conn }, skills },
    })
    const { BuiltinWorkerAdapter } = requireAgent('./dist/workers/builtin/adapter.js')
    adapter = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: ctx => agent.buildBuiltinWorkerRuntime(ctx), traceHooks: {
      startIncarnationTrace: p => { trace({ kind: 'start', ...p }); return p.worker_id },
      appendTurn: (id, event) => trace({ kind: 'turn', id, event }),
      appendToolLifecycle: (id, event) => trace({ kind: 'tool', id, event }),
      finishIncarnationTrace: (id, result) => trace({ kind: 'finish', id, result }),
    } })
  } else {
    const Adapter = impl === 'codex'
      ? requireAgent('./dist/workers/codex/adapter.js').CodexWorkerAdapter
      : requireAgent('./dist/workers/claude-code/adapter.js').ClaudeCodeAdapter
    adapter = new Adapter({ dataDir })
  }
  await adapter.provision({ root: workspace }, { skills, mcp_servers: [] })
  await append({ kind: 'fixture', impl, root, script_hash: hash(script), skill_hash: hash(await fs.readFile(path.join(skills[1].skill_dir, 'SKILL.md'), 'utf8')),
    configuration: impl === 'builtin' ? 'existing powerful slot via buildConnectionInfo' : 'existing_host; native adapter approval defaults',
    version: impl === 'builtin' ? '07872f60 + candidate' : execFileSync(impl === 'codex' ? 'codex' : 'claude', ['--version'], { encoding: 'utf8' }).trim(),
  })
  const tasks = [
    ['run', '运行项目现有脚本，用 endpoint.txt 指向的本地服务提供的全部输入生成 report.json，核验实际结果。'],
    ['docs', 'README 中 node old-report.mjs 已过时。修正为项目实际入口，并运行验证。此次只勘误，没有新增长期政策。'],
    ['reread', '接手项目：读取当前 README，按当前文档的命令重新生成 report.json，核验结果。'],
  ]
  for (const [stage, task] of tasks) {
    if (process.argv[3] === 'docs-only' && stage === 'run') continue
    await fs.rm(path.join(workspace, 'report.json'), { force: true })
    if (stage === 'docs') await fs.writeFile(path.join(workspace, 'README.md'), '# Report\n\nRun `node old-report.mjs`.\n')
    const workerId = `eval-${impl}-${stage}-${randomUUID().slice(0, 8)}`
    const snapshot = await captureWorkspaceInstructions({ workersDir: dataDir, workerId, incarnationId: workerId, workspaceRoot: workspace, capturedAt: new Date().toISOString() })
    const spec = { worker_id: workerId, incarnation_id: workerId, workspace: { root: workspace },
      workspace_instructions: snapshot,
      prompt: `项目为 ${workspace}。遵循已装配的 workspace-context-maintenance 规则。${task} 不提交、不发布。`,
    }
    if (agent) spec.builtin = agent.buildBuiltinWorkerRuntime(spec)
    const servedBefore = served.length
    await append({ kind: 'stage-start', stage, workerId })
    handle = await adapter.spawn(spec)
    await append({ kind: 'initial-input', stage, result: handle.initial_input ?? null })
    if (handle.initial_input && handle.initial_input.disposition !== 'accepted') {
      const terminal = await adapter.readTerminal(handle)
      const screen = JSON.stringify(terminal)
      await append({ kind: 'startup-terminal', stage, terminal })
      if (impl === 'codex' && screen.includes('Update available!') && screen.includes('2. Skip')) {
        await adapter.respondToUi(handle, { kind: 'keys', keys: ['2', 'Enter'] })
        let afterSkip = await adapter.readTerminal(handle)
        const uiDeadline = Date.now() + 15000
        while (JSON.stringify(afterSkip).includes('Update available!') && Date.now() < uiDeadline) {
          await new Promise(resolve => setTimeout(resolve, 200))
          afterSkip = await adapter.readTerminal(handle)
        }
        await append({ kind: 'after-update-skip', stage, terminal: afterSkip })
        const afterText = JSON.stringify(afterSkip)
        assert(!afterText.includes('Update available!'), 'Update dialog did not close')
        assert(!afterText.includes('Pasted text') && !afterText.includes(task), 'Pending task is still visible; do not paste twice')
        assert.equal((await adapter.readTrace(handle)).events.filter(event => event.kind === 'message' && event.role === 'user').length, 0,
          'Task already entered native history; do not deliver twice')
        await adapter.sendInput(handle, spec.prompt)
        await append({ kind: 'startup-resolved', stage, action: 'Skipped optional native update; delivered previously unpasted task' })
      }
    }
    const deadline = Date.now() + 300000
    let state = await adapter.state(handle)
    while (state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      state = await adapter.state(handle)
    }
    const native = impl === 'builtin' ? null : await adapter.readTrace(handle)
    await append({ kind: 'native-trace', stage, native })
    const readme = await fs.readFile(path.join(workspace, 'README.md'), 'utf8')
    const reportText = await fs.readFile(path.join(workspace, 'report.json'), 'utf8').catch(() => null)
    const report = reportText ? JSON.parse(reportText) : null
    const objective = report?.count === 3 && report?.total === 12 && served.length > servedBefore
      && (stage === 'run' || (readme.includes('node report.mjs') && !readme.includes('old-report')))
      && await fs.readFile(path.join(workspace, 'report.mjs'), 'utf8') === script
    await append({ kind: 'stage-result', stage, state, report, readme, served: served.slice(servedBefore), objective_evidence: objective, semantic_review_required: true })
    console.log(JSON.stringify({ impl, stage, state, objective_evidence: objective }))
    await adapter.kill(handle)
    handle = undefined
  }
} catch (error) {
  await append({ kind: 'error', message: error.message })
  console.log(JSON.stringify({ impl, error: error.message }))
  process.exitCode = 1
} finally {
  if (handle) await adapter.kill(handle).catch(error => { cleanupError = error.message; trace({ kind: 'cleanup-error', message: error.message }) })
  await adapter?.dispose?.()
  await agent?.stop()
  await new Promise(resolve => server.close(resolve))
  await Promise.all(traceWrites)
  // Keep fixture and native traces for review; remove only copied credentials after the workers stop.
  if (impl === 'codex' && !cleanupError) {
    for (const name of ['auth.json', 'config.toml']) await fs.rm(path.join(workspace, '.codex', name), { force: true })
  }
  await append({ kind: 'cleanup', retained_fixture: root, workers_stopped: !cleanupError })
}
