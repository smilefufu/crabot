const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { parse: parseToml, stringify: stringifyToml } = require('smol-toml')
const { WorkspaceGitInspector } = require('../../dist/workers/harness/workspace-git-inspector.js')
const { createWorkspaceGitMcpServerConfig, workspaceGitBridgeEnv, WORKSPACE_GIT_CONTEXT_ENV } = require('../../dist/workers/workspace-git-capability.js')

const exec = promisify(execFile)

function configOverrides(value, keys = []) {
  return Object.entries(value).flatMap(([key, item]) => {
    const names = [...keys, key]
    if (item && typeof item === 'object' && !Array.isArray(item)) return configOverrides(item, names)
    const literal = stringifyToml({ value: item }).trim().slice('value'.length)
    if (names.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error('unsupported native connection key')
    return ['-c', `${names.join('.')}${literal}`]
  })
}

async function run(impl) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `crabot-git-${impl}-smoke-`))
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), `crabot-git-${impl}-runtime-`))
  const baseline = (await new WorkspaceGitInspector().inspect(root)).current
  const binding = { worker_id: 'w-smoke', incarnation_id: `${impl}-smoke`, workspace_root: root, baseline }
  const bridge = createWorkspaceGitMcpServerConfig()
  let connectionArgs = []
  if (impl === 'codex') {
    const configFile = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml')
    const config = parseToml(await fs.readFile(configFile, 'utf8').catch(() => ''))
    const connection = Object.fromEntries(['model', 'model_provider', 'model_providers'].filter((key) => config[key] !== undefined).map((key) => [key, config[key]]))
    connectionArgs = configOverrides(connection)
  }
  const prompt = 'Call the inspect_workspace_git MCP tool exactly once with empty arguments. Report the returned worker_id, incarnation_id, current Git status and comparison. Do not use any other tools or modify files.'
  const args = impl === 'claude'
    ? ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { [bridge.name]: {
        command: bridge.command, args: bridge.args,
      } } }), '--tools', '', '--allowedTools', `mcp__${bridge.name}__inspect_workspace_git`,
      '--disable-slash-commands', '--permission-mode', 'auto', '--settings', '{"disableAllHooks":true}']
    : ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
      '-c', `mcp_servers.${bridge.name}.command=${JSON.stringify(bridge.command)}`,
      '-c', `mcp_servers.${bridge.name}.args=${JSON.stringify(bridge.args)}`,
      '-c', `mcp_servers.${bridge.name}.env_vars=${JSON.stringify([WORKSPACE_GIT_CONTEXT_ENV])}`,
      ...connectionArgs, prompt]
  let stdout = ''
  let failed = false
  let failure
  try {
    const pending = exec(impl, args, { cwd: root, env: { ...process.env, ...await workspaceGitBridgeEnv(runtime, 1, binding) },
      timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
    pending.child.stdin?.end()
    stdout = (await pending).stdout
  } catch (error) {
    stdout = error.stdout ?? ''
    failed = true
    failure = error.killed ? 'native_cli_timeout' : `native_cli_exit_${error.code}`
  }
  const events = stdout.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const calls = impl === 'claude'
    ? events.filter((event) => event.type === 'assistant').flatMap((event) => event.message?.content ?? []).filter((part) => part.type === 'tool_use')
    : events.filter((event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call').map((event) => event.item)
  const gitCalls = calls.filter((call) => (call.name ?? call.tool)?.endsWith('inspect_workspace_git'))
  const results = impl === 'claude'
    ? events.filter((event) => event.type === 'user').flatMap((event) => event.message?.content ?? []).filter((part) => part.type === 'tool_result' && gitCalls.some((call) => call.id === part.tool_use_id)).map((part) => part.content)
    : gitCalls.map((call) => call.result?.content)
  const observations = results.flatMap((content) => typeof content === 'string' ? [content] : (content ?? []).filter((part) => part.type === 'text').map((part) => part.text)).flatMap((value) => {
    try { return [JSON.parse(value)] } catch { return [] }
  })
  const toolSeen = gitCalls.length === 1 && calls.length === 1
  const identitySeen = observations.some((value) => value.worker_id === binding.worker_id && value.incarnation_id === binding.incarnation_id)
  const comparisonSeen = observations.some((value) => value.git?.current.state.status === 'not_repository' && value.git.comparison === 'not_repository' && value.git.baseline.captured_at === baseline.captured_at)
  const noFiles = (await fs.readdir(root)).length === 0
  const result = { impl, passed: !failed && toolSeen && identitySeen && comparisonSeen && noFiles,
    ...(failure ? { failure } : {}), tool_seen: toolSeen, identity_seen: identitySeen,
    comparison_seen: comparisonSeen, workspace_unchanged: noFiles, tool_call_count: calls.length, result_count: observations.length, event_count: events.length,
    event_types: [...new Set(events.map((event) => event.type))],
    errors: [...new Set(events.filter((event) => event.type === 'error' || event.type === 'turn.failed').map((event) => String(event.message ?? event.error?.message ?? 'native error').replace(/(?:https?|wss?):\/\/\S+/g, '[endpoint]').replace(/sk-[^\s.,]+/g, '[credential]').slice(0, 500)))] }
  console.log(JSON.stringify(result))
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(runtime, { recursive: true, force: true })
  if (!result.passed) process.exitCode = 1
}

const impl = process.argv[2]
if (!['claude', 'codex'].includes(impl)) throw new Error('usage: node cli-smoke.cjs claude|codex')
run(impl).catch((error) => { console.error(error.code ?? error.name); process.exitCode = 1 })
