import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { parse as parseToml } from 'smol-toml'
import { verifyNativeRuntimeMetadata } from '../../src/workers/provision/native-runtime.js'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { ClaudeCodeAdapter, eventsFilePath as claudeEvents } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter, eventsFilePath as codexEvents } from '../../src/workers/codex/adapter.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
it.each(['claude', 'codex'] as const)('%s provisions two executors privately in one project without changing tracked user configuration', async impl => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'private-project-'))); roots.push(root)
  const data = path.join(root, 'data'), project = path.join(root, 'project'), nativeHome = path.join(root, 'native-home'), skill = path.join(root, 'skill')
  await fs.mkdir(data); await fs.mkdir(nativeHome); await fs.mkdir(skill); await fs.mkdir(path.join(project, '.claude'), { recursive: true }); await fs.mkdir(path.join(project, '.codex'))
  const userFiles = { '.mcp.json': '{"mcpServers":{"user":{"command":"user-command"}}}', '.claude/settings.json': '{"language":"Chinese"}',
    '.codex/config.toml': 'model_reasoning_effort="high"\n', 'AGENTS.md': 'User project rules.\n' }
  for (const [name, content] of Object.entries(userFiles)) await fs.writeFile(path.join(project, name), content)
  await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: task-skill\ndescription: task skill\n---\nTask skill body.\n')
  execFileSync('git', ['init', '-q'], { cwd: project }); execFileSync('git', ['add', '.'], { cwd: project })
  const manager = new WorkspaceManager(path.join(data, 'workspaces'), data)
  const a = await manager.resolve('worker-a', project), b = await manager.resolve('worker-b', project)
  const adapter = impl === 'claude'
    ? new ClaudeCodeAdapter({ dataDir: path.join(data, 'adapters/claude'), claudeConfigPath: path.join(nativeHome, 'claude.json'), claudeProjectsDir: path.join(nativeHome, 'projects') })
    : new CodexWorkerAdapter({ dataDir: path.join(data, 'adapters/codex'), codexHomeSource: nativeHome })
  const caps = (secret: string) => ({ skills: [{ id: 'task-skill', name: 'task-skill', skill_dir: skill }], mcp_servers: [{ name: 'owned', transport: 'stdio' as const, command: 'fixture-command', env: { API_KEY: secret } }] })
  try {
    await adapter.provision(a, caps('fixture-a')); await adapter.provision(b, caps('fixture-b'))
    for (const [name, content] of Object.entries(userFiles)) expect(await fs.readFile(path.join(project, name), 'utf8')).toBe(content)
    expect((await fs.readdir(project)).sort()).toEqual(['.claude', '.codex', '.git', '.mcp.json', 'AGENTS.md'].sort())
    const events = impl === 'claude' ? claudeEvents : codexEvents
    expect(events(a)).not.toBe(events(b)); expect(events(a).startsWith(a.runtime_root!)).toBe(true)
    if (impl === 'claude') {
      expect(JSON.parse(await fs.readFile(path.join(a.runtime_root!, '.mcp.json'), 'utf8')).mcpServers.owned.env.API_KEY).toBe('fixture-a')
      expect(JSON.parse(await fs.readFile(path.join(b.runtime_root!, '.mcp.json'), 'utf8')).mcpServers.owned.env.API_KEY).toBe('fixture-b')
      expect(await fs.readFile(path.join(a.runtime_root!, 'claude-plugin/skills/task-skill/SKILL.md'), 'utf8')).toContain('Task skill body')
    } else {
      expect((parseToml(await fs.readFile(path.join(a.runtime_root!, '.codex/config.toml'), 'utf8')) as any).mcp_servers.owned.env.API_KEY).toBe('fixture-a')
      expect((parseToml(await fs.readFile(path.join(b.runtime_root!, '.codex/config.toml'), 'utf8')) as any).mcp_servers.owned.env.API_KEY).toBe('fixture-b')
      expect(await fs.readFile(path.join(a.runtime_root!, '.codex/skills/task-skill/SKILL.md'), 'utf8')).toContain('Task skill body')
    }
  } finally { await adapter.dispose() }
})

it('cold native metadata never falls back to project credentials for malformed or incomplete private bindings', () => {
  expect(() => verifyNativeRuntimeMetadata({ workspace_root: '/historical' })).not.toThrow()
  const valid = { workspace_root: path.resolve('project'), workspace_id: 'default', runtime_root: path.resolve('profile') }
  expect(() => verifyNativeRuntimeMetadata(valid)).not.toThrow()
  for (const change of [{ workspace_id: '' }, { runtime_root: '' }, { runtime_root: 'relative' }, { workspace_root: '' },
    { workspace_id: undefined }, { runtime_root: undefined }, { runtime_root: null }, { workspace_id: 'not-an-id' }]) {
    expect(() => verifyNativeRuntimeMetadata({ ...valid, ...change })).toThrow('fallback refused')
  }
})
