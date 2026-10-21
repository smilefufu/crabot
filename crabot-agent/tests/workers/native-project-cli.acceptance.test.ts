import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Workspace } from '../../src/workers/types.js'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import { EVENTS_FILE_ENV } from '../../src/workers/cli-events.js'
import { nativeEventChannel } from '../../src/workers/provision/native-runtime.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const run = promisify(execFile)
const mcp = fileURLToPath(new URL('./fixtures/native-workspace-mcp.mjs', import.meta.url))

function nativeEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8',
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }
}
async function bothExecutors(operation: (marker: string) => Promise<Workspace>): Promise<Workspace[]> {
  const results = await Promise.allSettled(['worker-a', 'worker-b'].map(operation))
  // Even a failing peer must finish before fixtures and owned child pipes are removed.
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return results.map(result => (result as PromiseFulfilledResult<Workspace>).value)
}

// Opt-in real native CLI; no business MM, remote provider or user credential is used.
it.skipIf(!process.env.CRABOT_TEST_CODEX_BIN)('real Codex loads two private MCP profiles in one shared project and writes separate native turn events', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "native-project-cli-中文 ' $space-")))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const data = path.join(root, 'data'), project = path.join(root, 'project'), home = path.join(root, 'home'), base = path.join(root, 'base')
  for (const directory of [data, project, home, base]) await fs.mkdir(directory)
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Shared project instructions.\n')
  const evidence = { requests: 0, tool_outputs: [] as string[], failures: [] as string[] }
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') throw new Error('Unexpected native fixture endpoint')
      let text = ''
      for await (const chunk of request) { text += chunk; if (text.length > 4 * 1024 * 1024) throw new Error('Request too large') }
      expect(text).toMatch(/native-private-skill-worker-[ab]/)
      const body = JSON.parse(text), output = body.input.filter((item: any) => item.type === 'function_call_output').at(-1)
      evidence.requests++; if (evidence.requests > 8) throw new Error('Unexpected retry loop')
      const namespace = body.tools.find((item: any) => item.type === 'namespace' && item.name === 'mcp__owned')
      const tool = namespace?.tools.find((item: any) => item.name === 'get_marker') ?? body.tools.find((item: any) => item.name?.endsWith('__get_marker'))
      if (!tool) throw new Error('Private MCP marker is absent: ' + JSON.stringify(body.tools.map((item: any) => ({ type: item.type, name: item.name }))))
      const content = output ? [{ id: 'message_' + evidence.requests, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Private profile verified.', annotations: [] }] }]
        : [{ id: 'tool_' + evidence.requests, type: 'function_call', call_id: 'marker_' + evidence.requests, name: tool.name, ...(namespace ? { namespace: namespace.name } : {}), arguments: '{}' }]
      if (output) evidence.tool_outputs.push(JSON.stringify(output.output))
      const reply = { id: 'response_' + evidence.requests, object: 'response', status: 'completed', model: body.model, output: content,
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (value: unknown) => response.write('data: ' + JSON.stringify(value) + '\n\n')
      send({ type: 'response.created', response: { ...reply, status: 'in_progress', output: [] } })
      for (const item of content) send({ type: 'response.output_item.done', output_index: 0, item })
      send({ type: 'response.completed', response: reply }); response.end()
    } catch (error) {
      evidence.failures.push((error as Error).message)
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Native workspace fixture rejected request' } }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1'
  await fs.writeFile(path.join(base, 'config.toml'), [
    'model="gpt-5.1-codex"', 'model_provider="fixture"', 'approval_policy="never"',
    // This acceptance covers private MCP/skills/hooks; marketplace cloning is unrelated outbound work.
    'features.plugins=false', 'features.recommended_plugins=false',
    '[model_providers.fixture]', 'name="Private local acceptance"', 'base_url=' + JSON.stringify(endpoint), 'wire_api="responses"',
  ].join('\n') + '\n')
  const manager = new WorkspaceManager(path.join(data, 'workspaces'), data)
  const adapter = new CodexWorkerAdapter({ dataDir: path.join(data, 'adapters'), codexHomeSource: base })
  cleanup.push(() => adapter.dispose())
  const env = nativeEnv(home)
  const profiles = await bothExecutors(async marker => {
    const workspace = await manager.resolve(marker, project)
    const markerFile = path.join(workspace.runtime_root!, 'marker-evidence')
    const skill = path.join(workspace.runtime_root!, 'skill-source'); await fs.mkdir(skill)
    await fs.writeFile(path.join(skill, 'SKILL.md'), `---\nname: marker-skill\ndescription: native-private-skill-${marker}\n---\nPrivate task skill.\n`)
    await adapter.provision(workspace, { skills: [{ id: 'marker-skill', name: 'marker-skill', skill_dir: skill }], mcp_servers: [{ name: 'owned', command: process.execPath, args: [mcp],
      env: { PRIVATE_MARKER: marker, MARKER_EVIDENCE: markerFile } }] })
    const eventFile = path.join(workspace.runtime_root!, '.codex/events-cli.jsonl')
    let result
    try {
      const execution = run(process.env.CRABOT_TEST_CODEX_BIN!, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--dangerously-bypass-hook-trust', '--json', 'Read the private marker.'], {
        cwd: project, env: { ...env, CODEX_HOME: path.join(workspace.runtime_root!, '.codex'), [EVENTS_FILE_ENV]: eventFile }, timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
      })
      execution.child.stdin?.end()
      result = await execution
    } catch (error) {
      throw new Error('Native Codex failed: ' + JSON.stringify({ failures: evidence.failures, stdout: (error as any).stdout, stderr: (error as any).stderr }))
    }
    expect(result.stdout, JSON.stringify({ stderr: result.stderr, evidence })).toContain('Private profile verified.')
    expect(await fs.readFile(markerFile, 'utf8')).toBe(marker + '\n')
    const events = await nativeEventChannel(workspace, '.codex').readAll()
    expect(events.some(event => event.kind === 'stop'), JSON.stringify({ stderr: result.stderr, marker })).toBe(true)
    return workspace
  })
  expect(profiles[0].workspace_id).toBe(profiles[1].workspace_id)
  expect(evidence.failures).toEqual([]); expect(evidence.tool_outputs).toHaveLength(2)
  expect(evidence.tool_outputs.some(output => output.includes('worker-a'))).toBe(true)
  expect(evidence.tool_outputs.some(output => output.includes('worker-b'))).toBe(true)
  expect(await fs.readdir(project)).toEqual(['AGENTS.md'])
}, 100_000)

it.skipIf(!process.env.CRABOT_TEST_CLAUDE_BIN)('real Claude Code uses private MCP settings and Stop hooks for two executors in one project', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "native-claude-project-中文 ' $space-")))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const data = path.join(root, 'data'), project = path.join(root, 'project'), home = path.join(root, 'home')
  for (const directory of [data, project, home]) await fs.mkdir(directory)
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Shared project instructions.\n')
  const evidence = { requests: 0, markers: [] as string[], failures: [] as string[] }
  const server = createServer(async (request, response) => {
    try {
      // Native CLI may probe optional platform capabilities; this fixture supplies none.
      if (request.url === '/api/hello') { response.writeHead(404); response.end('{}'); return }
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) throw new Error('Unexpected Claude fixture endpoint: ' + request.url)
      let text = ''
      for await (const chunk of request) { text += chunk; if (text.length > 4 * 1024 * 1024) throw new Error('Request too large') }
      expect(text).toMatch(/native-private-skill-worker-[ab]/)
      const body = JSON.parse(text)
      if (body.stream !== true) throw new Error('Expected streaming native request')
      const result = body.messages.at(-1)?.content?.find?.((item: any) => item.type === 'tool_result')
      const tool = body.tools.find((item: any) => item.name === 'mcp__owned__get_marker')
      if (!tool) throw new Error('Private MCP marker absent')
      const id = ++evidence.requests
      if (id > 8) throw new Error('Unexpected native retry loop')
      if (result) evidence.markers.push(JSON.stringify(result.content))
      const block = result ? { type: 'text', text: 'Private Claude profile verified.' }
        : { type: 'tool_use', id: 'marker_' + id, name: tool.name, input: {} }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (event: string, value: unknown) => response.write('event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n')
      send('message_start', { type: 'message_start', message: { id: 'message_' + id, type: 'message', role: 'assistant', model: body.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } })
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: block.type === 'text' ? { ...block, text: '' } : block })
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: result ? { type: 'text_delta', text: block.text }
        : { type: 'input_json_delta', partial_json: '{}' } })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: result ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } })
      send('message_stop', { type: 'message_stop' }); response.end()
    } catch (error) {
      evidence.failures.push((error as Error).message)
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Native Claude fixture rejected request' } }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const manager = new WorkspaceManager(path.join(data, 'workspaces'), data)
  const adapter = new ClaudeCodeAdapter({ dataDir: path.join(data, 'adapters'), claudeConfigPath: path.join(home, '.claude.json'), claudeProjectsDir: path.join(home, '.claude/projects') })
  cleanup.push(() => adapter.dispose())
  const profiles = await bothExecutors(async marker => {
    const workspace = await manager.resolve(marker, project), runtime = workspace.runtime_root!
    const markerFile = path.join(runtime, 'marker-evidence')
    const skill = path.join(workspace.runtime_root!, 'skill-source'); await fs.mkdir(skill)
    await fs.writeFile(path.join(skill, 'SKILL.md'), `---\nname: marker-skill\ndescription: native-private-skill-${marker}\n---\nPrivate task skill.\n`)
    await adapter.provision(workspace, { skills: [{ id: 'marker-skill', name: 'marker-skill', skill_dir: skill }], mcp_servers: [{ name: 'owned', command: process.execPath, args: [mcp],
      env: { PRIVATE_MARKER: marker, MARKER_EVIDENCE: markerFile } }] })
    const eventFile = path.join(runtime, '.claude/events-cli.jsonl')
    const execution = run(process.env.CRABOT_TEST_CLAUDE_BIN!, ['-p', 'Read the private marker.', '--output-format', 'stream-json', '--verbose',
      '--model', 'claude-sonnet-4-6', '--max-turns', '3', '--permission-mode', 'default', '--allowedTools', 'mcp__owned__get_marker',
      '--mcp-config', path.join(runtime, '.mcp.json'), '--strict-mcp-config', '--settings', path.join(runtime, '.claude/settings.json'),
      '--plugin-dir', path.join(runtime, 'claude-plugin')], {
      cwd: project, env: { ...nativeEnv(home),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: 'local-native-fixture',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', [EVENTS_FILE_ENV]: eventFile },
      timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
    })
    execution.child.stdin?.end()
    let result
    try { result = await execution } catch (error) {
      throw new Error('Native Claude failed: ' + JSON.stringify({ evidence, stdout: (error as any).stdout, stderr: (error as any).stderr }))
    }
    expect(result.stdout, JSON.stringify({ stderr: result.stderr, evidence })).toContain('Private Claude profile verified.')
    expect(await fs.readFile(markerFile, 'utf8')).toBe(marker + '\n')
    expect((await nativeEventChannel(workspace, '.claude').readAll()).some(event => event.kind === 'stop')).toBe(true)
    return workspace
  })
  expect(profiles[0].workspace_id).toBe(profiles[1].workspace_id)
  expect(evidence.failures).toEqual([]); expect(evidence.markers).toHaveLength(2)
  expect(evidence.markers.some(output => output.includes('worker-a'))).toBe(true)
  expect(evidence.markers.some(output => output.includes('worker-b'))).toBe(true)
  expect(await fs.readdir(project)).toEqual(['AGENTS.md'])
}, 100_000)
