const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { createAdapter } = require('../../dist/engine/llm-adapter.js')
const { runEngine } = require('../../dist/engine/query-loop.js')
const { defineTool } = require('../../dist/engine/tool-framework.js')
const { getAllBuiltinTools } = require('../../dist/engine/tools/index.js')
const { createWorkspaceGitTool } = require('../../dist/workers/workspace-git-capability.js')
const { WorkspaceGitInspector, appendWorkspaceGitObservation } = require('../../dist/workers/harness/workspace-git-inspector.js')
const { assembleManagerSystemPrompt } = require('../../dist/manager/prompt.js')
const { buildWorkerTools } = require('../../dist/manager/tools/worker-tools.js')
const { authorizeProjectRoot } = require('../../dist/manager/tools/project-doc-tools.js')
const { WorkerHarness } = require('../../dist/workers/harness/harness.js')
const { WorkspaceManager } = require('../../dist/workers/harness/workspace-manager.js')
const { LedgerStore } = require('../../dist/workers/harness/ledger-store.js')
const { BUILTIN_WORKER_PERMISSIONS } = require('../../dist/workers/builtin/runtime.js')

const exec = promisify(execFile)
const OLD_CODE = 'exports.sum = (a, b) => a - b;\n'
const RULES = '# Project rules\n\nUse CommonJS. Validate with node test.cjs. Preserve unrelated changes.\n'
const TEST = "const assert = require('node:assert/strict'); const { sum } = require('./sum.cjs'); assert.equal(sum(2, 3), 5); assert.equal(sum(-2, 1), -1);\n"
const skillDir = path.resolve(__dirname, '../../../crabot-admin/builtin-skills/workspace-context-maintenance')
const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md', '.gitignore', 'sum.cjs', 'test.cjs', 'other.txt', 'notes.txt']

async function validateFile(project, file) {
  const target = path.resolve(project, file)
  if (!PROJECT_FILES.includes(path.relative(project, target))) throw new Error('evaluation file is outside the fixture allowlist')
  const stat = await fs.lstat(target).catch((error) => { if (error.code !== 'ENOENT') throw error })
  if (stat && !stat.isFile()) throw new Error('evaluation only accepts regular fixture files')
  return target
}

async function runProjectTest(project) {
  const canonical = await fs.realpath(project)
  return exec(process.execPath, ['--permission', `--allow-fs-read=${canonical}`, 'test.cjs'], {
    cwd: project, env: { PATH: process.env.PATH, LANG: 'C' }, timeout: 10_000, maxBuffer: 1024 * 1024,
  })
}

function boundedWorkerTools(project, skill) {
  const files = getAllBuiltinTools(() => project, { availableSkills: [skill] })
    .filter((tool) => ['Read', 'Write', 'Edit', 'Skill'].includes(tool.name))
    .map((tool) => ({ ...tool, async call(input, context) {
      try {
        if (tool.name === 'Skill') {
          if (input.skill !== skill.name && input.skill !== 'list') throw new Error('unknown fixture skill')
        } else await validateFile(project, input.file_path)
        return await tool.call(input, context)
      } catch (error) { return { isError: true, output: error.message } }
    } }))
  files.push(defineTool({ name: 'run_project_git', description: '在固定样例仓库执行 Git 操作。add 的 paths 必须显式列出；commit 带 paths 时只提交这些文件。无通用 Shell。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      operation: { type: 'string', enum: ['init', 'status', 'diff', 'add', 'commit', 'log'] },
      paths: { type: 'array', items: { type: 'string', enum: PROJECT_FILES } }, message: { type: 'string' }, staged: { type: 'boolean' },
    }, required: ['operation'] }, isReadOnly: false, async call(input) {
      try {
        const paths = input.paths ?? []
        if (!Array.isArray(paths) || paths.some((file) => !PROJECT_FILES.includes(file))) throw new Error('invalid fixture Git paths')
        const argumentsByOperation = {
          init: ['init', '-b', 'main'], status: ['status', '--short'],
          diff: ['diff', '--no-ext-diff', '--no-textconv', ...(input.staged ? ['--cached'] : []), '--', ...paths],
          add: ['add', '--', ...paths],
          commit: ['commit', '-m', String(input.message ?? 'fixture change'), ...(paths.length ? ['--only', '--', ...paths] : [])],
          log: ['log', '--oneline', '--max-count=10'],
        }
        if (!(input.operation in argumentsByOperation) || (input.operation === 'add' && paths.length === 0)) throw new Error('invalid fixture Git operation')
        return { output: await git(project, ...argumentsByOperation[input.operation]), isError: false }
      } catch (error) { return { isError: true, output: String(error.stderr ?? error.message).slice(0, 2000) } }
    } }))
  files.push(defineTool({ name: 'test_project', description: '运行固定入口 node test.cjs。Node 权限仅允许读取样例目录，禁止网络、子进程和文件写入。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, isReadOnly: true, async call() {
      try { const result = await runProjectTest(project); return { output: result.stdout || 'tests passed', isError: false } }
      catch (error) { return { output: String(error.stderr ?? error.message).slice(0, 2000), isError: true } }
    } }))
  return files
}

async function git(root, ...args) {
  return (await exec('git', ['-C', root, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trim()
}

async function read(root, file) { return fs.readFile(path.join(root, file), 'utf8').catch(() => undefined) }

async function initialize(root) {
  await git(root, 'init', '-b', 'main')
  await git(root, 'add', '--', 'AGENTS.md', 'sum.cjs', 'test.cjs', 'other.txt', 'notes.txt')
  await git(root, 'commit', '-m', 'fixture baseline')
}

async function engineRun(delegate, model, directory, systemPrompt, prompt, tools) {
  const requests = []
  const calls = []
  const adapter = {
    updateConfig: (...args) => delegate.updateConfig(...args),
    stream(params) {
      requests.push(structuredClone({ systemPrompt: params.systemPrompt, messages: params.messages,
        tools: params.tools.map(({ name, inputSchema }) => ({ name, inputSchema })) }))
      return delegate.stream(params)
    },
  }
  const recordedTools = tools.map((tool) => ({ ...tool, async call(input, context) {
    const entry = { name: tool.name, input: structuredClone(input) }
    calls.push(entry)
    const result = await tool.call(input, context)
    Object.assign(entry, { output: result.output, isError: result.isError })
    return result
  } }))
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 240_000)
  let result
  try {
    result = await runEngine({ adapter, prompt, options: { model, systemPrompt, tools: recordedTools,
      maxTurns: 30, maxTokens: 4096, abortSignal: abort.signal,
      suppressForcedSummary: () => true, disableCompaction: true } })
  } finally {
    clearTimeout(timer)
    await fs.writeFile(path.join(directory, 'requests.json'), JSON.stringify(requests, null, 2))
    await fs.writeFile(path.join(directory, 'tool-calls.json'), JSON.stringify(calls, null, 2))
  }
  return { result, calls, requestCount: requests.length,
    staticPromptStable: new Set(requests.map((item) => item.systemPrompt)).size === 1,
    observationOnlyInMessages: requests.every((item) => !item.systemPrompt.includes('<workspace-git-observation>')) }
}

async function workerScenario(id, directory, delegate, model) {
  const project = path.join(directory, 'project')
  await fs.mkdir(project)
  const existing = !['new', 'readonly'].includes(id)
  const repoExists = ['dirty', 'no-commit', 'baseline-failure'].includes(id)
  const rules = RULES + (id === 'no-commit' ? '\nDo not create any commits automatically. Leave the requested patch uncommitted.\n' : '')
  if (existing) {
    await fs.writeFile(path.join(project, 'sum.cjs'), OLD_CODE)
    await fs.writeFile(path.join(project, 'test.cjs'), TEST)
    await fs.writeFile(path.join(project, 'README.md'), '# Sum\nCommonJS utility. Validate with node test.cjs.\n')
  }
  if (id === 'claude-only') await fs.writeFile(path.join(project, 'CLAUDE.md'), RULES)
  if (repoExists) {
    await fs.writeFile(path.join(project, 'AGENTS.md'), rules)
    await fs.writeFile(path.join(project, 'other.txt'), 'original other\n')
    await fs.writeFile(path.join(project, 'notes.txt'), 'original notes\n')
    if (id === 'baseline-failure') {
      await git(project, 'init', '-b', 'main')
      await fs.writeFile(path.join(project, '.git/hooks/pre-commit'), '#!/bin/sh\necho fixture-baseline-hook-failed >&2\nexit 1\n', { mode: 0o755 })
    } else await initialize(project)
  }
  if (id === 'dirty') {
    await fs.writeFile(path.join(project, 'other.txt'), 'staged unrelated\n')
    await git(project, 'add', '--', 'other.txt')
    await fs.writeFile(path.join(project, 'notes.txt'), 'unstaged unrelated\n')
  }
  const beforeHead = await git(project, 'rev-parse', '--verify', 'HEAD').catch(() => null)
  const baseline = (await new WorkspaceGitInspector().inspect(project)).current
  const skill = { name: 'workspace-context-maintenance', skill_dir: skillDir,
    description: '持续开发代码项目时补齐必要规则和版本基线，遵循项目约定；按需读取项目文档，并依据 Harness Git 检测保护、验证和提交本任务改动' }
  const tools = [...boundedWorkerTools(project, skill), createWorkspaceGitTool({
    worker_id: id, incarnation_id: `${id}-1`, workspace_root: project, baseline,
  })]
  const system = `你是主线代码执行器，完成主控分配的任务。工作目录：${project}\n<available_skills>\n${JSON.stringify(skill)}\n</available_skills>\n按适用的共享 Skill 和已有项目规则完成工作，如实报告结果。本评测提供限定样例文件的 Read/Write/Edit、run_project_git 和 test_project，分别完成文件操作、Git 操作和 node test.cjs 验证；没有通用 Shell。`
  const task = id === 'readonly'
    ? '只读检查这个空目录是否已有可运行的项目，简短报告事实。'
    : id === 'new'
      ? '这是需要持续维护的新代码项目。补齐必要规则和 Git 基线后，实现 sum.cjs 导出 sum(a,b) 返回两数相加，并创建 test.cjs 覆盖正数与负数。只使用 Node.js 内置库，运行 node test.cjs 验证，按项目规则收尾。'
      : '这是需要持续维护的代码项目。本次只把 sum.cjs 的 sum(a,b) 修为两数相加；已有 test.cjs 是验证入口。先处理必要规则和 Git 基线，再改业务代码、验证并按项目约定收尾。不要修改其他人的文件。'
  const execution = await engineRun(delegate, model, directory, system, appendWorkspaceGitObservation(task, baseline), tools)
  const afterHead = await git(project, 'rev-parse', '--verify', 'HEAD').catch(() => null)
  const assertions = { static_prompt_stable: execution.staticPromptStable, dynamic_observation_in_messages: execution.observationOnlyInMessages }
  if (id === 'readonly') assertions.no_initialization = (await fs.readdir(project)).length === 0
  else if (id === 'baseline-failure') {
    assertions.business_unchanged = await read(project, 'sum.cjs') === OLD_CODE
    assertions.no_false_baseline = afterHead === null
    assertions.hook_preserved = (await read(project, '.git/hooks/pre-commit')).includes('exit 1')
  } else {
    assertions.tests_pass = await runProjectTest(project).then(() => true, () => false)
    if (id !== 'no-commit') assertions.business_in_commit = Boolean(afterHead) &&
      await git(project, 'show', 'HEAD:sum.cjs').catch(() => undefined) === (await read(project, 'sum.cjs'))?.trim()
    if (id === 'no-commit') {
      assertions.no_automatic_commit = afterHead === beforeHead
      assertions.existing_rules_preserved = await read(project, 'AGENTS.md') === rules
    } else if (id === 'dirty') {
      assertions.task_committed = afterHead !== beforeHead && Boolean(afterHead)
      assertions.unrelated_index_preserved = await git(project, 'show', ':other.txt') === 'staged unrelated'
      assertions.unrelated_worktree_preserved = await read(project, 'notes.txt') === 'unstaged unrelated\n'
      assertions.unrelated_not_committed = await git(project, 'show', 'HEAD:other.txt') === 'original other'
      assertions.existing_rules_preserved = await read(project, 'AGENTS.md') === rules
    } else {
      const commits = afterHead ? (await git(project, 'rev-list', '--reverse', 'HEAD')).split('\n') : []
      assertions.baseline_then_business_commit = commits.length >= 2
      const firstCode = commits.length ? await git(project, 'show', `${commits[0]}:sum.cjs`).catch(() => undefined) : undefined
      assertions.original_business_baseline = id === 'new' ? firstCode === undefined : firstCode === OLD_CODE.trim()
      assertions.rules_in_baseline = commits.length > 0 && Boolean(await git(project, 'show', `${commits[0]}:${id === 'claude-only' ? 'CLAUDE.md' : 'AGENTS.md'}`).catch(() => undefined))
      if (id === 'claude-only') {
        assertions.claude_body_preserved = await read(project, 'CLAUDE.md') === RULES
        const agents = await fs.lstat(path.join(project, 'AGENTS.md')).catch(() => undefined)
        assertions.no_second_body = !agents || agents.isSymbolicLink()
      }
    }
  }
  return { id, passed: Object.values(assertions).every(Boolean), assertions, request_count: execution.requestCount,
    tool_calls: execution.calls.map((item) => item.name), final_text: execution.result.finalText,
    git: await new WorkspaceGitInspector().inspect(project, baseline) }
}

async function managerScenario(directory, delegate, model) {
  const project = path.join(directory, 'project')
  await fs.mkdir(project)
  for (const [file, value] of Object.entries({ 'AGENTS.md': RULES, 'sum.cjs': OLD_CODE, 'test.cjs': TEST, 'other.txt': '', 'notes.txt': '' })) await fs.writeFile(path.join(project, file), value)
  await initialize(project)
  const ledger = new LedgerStore(path.join(directory, 'ledger'))
  const received = []
  let handle
  const adapter = { implId: 'builtin', provision: async () => {},
    spawn: async (spec) => (handle = { worker_id: spec.worker_id, incarnation_id: spec.incarnation_id, seq: 1, impl: 'builtin', session_ref: 'eval-session' }),
    state: async () => 'idle', sendInput: async (_handle, input) => { received.push(input) },
    readTrace: async () => ({ events: [], nextCursor: { offset: 0 } }),
    capabilities: () => ({ fork: false, revive: false, goalMode: false, subagent: false, structuredTrace: true }) }
  const harness = new WorkerHarness({ adapters: new Map([['builtin', adapter]]), defaultImpl: 'builtin', ledger,
    workspaces: new WorkspaceManager(path.join(directory, 'workspaces')), workersDir: path.join(directory, 'workers'), now: () => new Date().toISOString() })
  const managerKey = 'eval::project-bootstrap'
  const worker = await harness.spawnWorker({ managerKey, title: '修复 sum', prompt: '修复 sum、验证并本地提交', workspace: project,
    origin: { trigger_type: 'message' }, report_to: { channel_id: 'eval', session_id: 'project-bootstrap' }, principal_permissions: BUILTIN_WORKER_PERMISSIONS })
  await fs.writeFile(path.join(project, 'sum.cjs'), 'exports.sum = (a, b) => a + b;\n')
  harness.handleStateChange(handle, 'idle', { completionSource: 'builtin_end_turn', lastText: '已完成、测试通过并提交 ffffffffffffffffffffffffffffffffffffffff' })
  let turn
  for (let attempt = 0; attempt < 100 && !turn; attempt++) { turn = await harness.getWorkerTurn(worker.worker_id); if (!turn) await new Promise((resolve) => setTimeout(resolve, 20)) }
  if (!turn) throw new Error('fixture turn did not persist')
  const sent = []
  const continued = new Set()
  const projectDeps = { ledger, managerKey, readWorkerContext: async () => ({ principal_permissions: BUILTIN_WORKER_PERMISSIONS }),
    wakeEvent: { kind: 'human_messages', messages: [], principalPermissions: BUILTIN_WORKER_PERMISSIONS } }
  const tools = buildWorkerTools({ harness, context: () => ({ managerKey, reportTo: worker.report_to }),
    authorizeProjectRead: (root) => authorizeProjectRoot(projectDeps, root, false),
    onWorkerContinuation: (id) => continued.add(id), hasContinuedWorker: (id) => continued.has(id), hasSuccessfulSendMessageTo: () => sent.length > 0,
    readWorkerActivity: async () => ({ incarnation_id: handle.incarnation_id, activities: [], unavailable_reason: 'fixture contains no test execution evidence' }),
  }).filter((tool) => ['inspect_workspace_git', 'get_worker_state', 'get_worker_turn', 'get_worker_activity', 'get_worker_detail', 'send_to_worker', 'resolve_worker_turn'].includes(tool.name))
  tools.push(defineTool({ name: 'send_message', description: '向当前会话报告；本评测只记录消息，不执行外部投递。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, channel_id: { type: 'string' }, session_id: { type: 'string' } }, required: ['text'] },
    isReadOnly: false, async call(input) { sent.push(input); return { output: '{"success":true}', isError: false } } }))
  const prompt = JSON.stringify({ original_request: '修复 sum，测试通过后本地提交。当前只有这项工作，项目规则已确认，无需另建任务板。',
    worker_id: worker.worker_id, report_to: worker.report_to, event: { kind: 'turn_completed', detail: { turn_id: turn.turn_id, turn_pending: true,
      summary: '已完成、测试通过并提交 ffffffffffffffffffffffffffffffffffffffff', workspace_git: turn.workspace_git } } })
  const execution = await engineRun(delegate, model, directory, assembleManagerSystemPrompt({ managerKey, isSystemThread: false }), prompt, tools)
  const resolved = await harness.getWorkerTurn(worker.worker_id, turn.turn_id)
  const assertions = { requested_continuation: received.length > 0, independently_read_facts: execution.calls.some((item) => ['inspect_workspace_git', 'get_worker_turn'].includes(item.name) && !item.isError),
    continued_with_evidence: resolved.disposition.resolution === 'continued', static_prompt_stable: execution.staticPromptStable }
  return { id: 'manager-false-commit', passed: Object.values(assertions).every(Boolean), assertions,
    request_count: execution.requestCount, tool_calls: execution.calls.map((item) => item.name), disposition: resolved.disposition, messages: sent, received }
}

async function main() {
  const missing = ['EVAL_FORMAT', 'EVAL_ENDPOINT', 'EVAL_API_KEY', 'EVAL_MODEL'].filter((name) => !process.env[name])
  if (missing.length) { console.log(JSON.stringify({ status: 'skipped', missing })); process.exitCode = 2; return }
  const model = process.env.EVAL_MODEL
  const delegate = createAdapter({ endpoint: process.env.EVAL_ENDPOINT, apikey: process.env.EVAL_API_KEY,
    format: process.env.EVAL_FORMAT, ...(process.env.EVAL_ACCOUNT_ID ? { accountId: process.env.EVAL_ACCOUNT_ID } : {}) })
  delete process.env.EVAL_API_KEY
  const outputRoot = process.env.EVAL_OUTPUT_DIR ? path.resolve(process.env.EVAL_OUTPUT_DIR) : await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-bootstrap-behavior-'))
  await fs.mkdir(outputRoot, { recursive: true })
  const root = await fs.realpath(outputRoot)
  // Fixture identity and hooks are isolated from the user's Git configuration.
  const fixtureGitConfig = path.join(root, 'gitconfig')
  await fs.writeFile(fixtureGitConfig, '[user]\n name = Crabot Evaluation\n email = eval@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = fixtureGitConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const scenarios = (process.env.EVAL_SCENARIOS ?? 'new,old-missing,claude-only,dirty,no-commit,readonly,baseline-failure,manager-false-commit').split(',')
  const reports = []
  for (const id of scenarios) {
    const directory = path.join(root, id)
    await fs.mkdir(directory)
    console.log(JSON.stringify({ scenario: id, status: 'running' }))
    try {
      const report = id === 'manager-false-commit' ? await managerScenario(directory, delegate, model) : await workerScenario(id, directory, delegate, model)
      reports.push(report)
      console.log(JSON.stringify({ scenario: id, passed: report.passed, assertions: report.assertions, request_count: report.request_count }))
    } catch (error) {
      reports.push({ id, passed: false, error: String(error.message).replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 500) })
      console.log(JSON.stringify({ scenario: id, passed: false, error: error.name }))
    }
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ model, reports }, null, 2))
  }
  console.log(JSON.stringify({ output_dir: root, passed: reports.every((report) => report.passed), scenarios: reports.length }))
  if (!reports.every((report) => report.passed)) process.exitCode = 1
}

module.exports = { main, boundedWorkerTools, runProjectTest }
if (require.main === module) main().catch((error) => { console.error(error.name); process.exitCode = 1 })
