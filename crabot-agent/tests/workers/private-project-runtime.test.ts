import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import { TmuxDriver, type TmuxSessionSpec } from '../../src/workers/tmux/driver.js'
import { EVENTS_FILE_ENV } from '../../src/workers/cli-events.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

/** Records real adapter assembly and native session evidence without starting a model or business process. */
class RecordingTmux extends TmuxDriver {
  readonly launches: TmuxSessionSpec[] = []
  private readonly panes = new Map<string, { spec: TmuxSessionSpec; text: string; alive: boolean }>()
  constructor(private readonly impl: 'claude' | 'codex') { super() }
  async newSession(spec: TmuxSessionSpec) {
    this.launches.push(spec)
    this.panes.set(spec.name, { spec, text: this.impl === 'claude' ? '❯ \n? for shortcuts' : '› \n? for shortcuts', alive: true })
    return { socket_path: path.join(os.tmpdir(), 'fixture.sock'), monitor_id: 'fixture' }
  }
  async getPasteReadiness() { return { state: 'ready' as const } }
  async pasteText(name: string, text: string) { this.panes.get(name)!.text = `${this.impl === 'claude' ? '❯' : '›'} ${text}\n? for shortcuts` }
  async sendKeys(name: string, keys: string[]) {
    if (!keys.includes('Enter')) return
    const pane = this.panes.get(name)!
    pane.text = this.impl === 'claude' ? '❯ \nesc to interrupt' : '› \nesc to interrupt'
    if (this.impl === 'codex') {
      const sessions = path.join(pane.spec.env!.CODEX_HOME, 'sessions')
      await fs.mkdir(sessions, { recursive: true })
      const id = randomUUID()
      await fs.writeFile(path.join(sessions, `rollout-2026-10-19T00-00-00-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n')
    }
  }
  async capturePane(name: string) { const pane = this.panes.get(name)!; return { text: pane.text, dead: !pane.alive } }
  async isAlive(name: string) { return this.panes.get(name)?.alive ?? false }
  async killSession(name: string) { const pane = this.panes.get(name); if (pane) pane.alive = false }
}

it.each(['claude', 'codex'] as const)('%s uses the same verified private profile across spawn and cold resume and rejects its loss', async impl => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'private-native-runtime-'))); roots.push(root)
  const data = path.join(root, 'data'), project = path.join(root, 'project'), home = path.join(root, 'native-home')
  await fs.mkdir(data); await fs.mkdir(project); await fs.mkdir(home)
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Shared user instructions')
  const workerId = 'worker-a', manager = new WorkspaceManager(path.join(data, 'workspaces'), data)
  const workspace = await manager.resolve(workerId, project), tmux = new RecordingTmux(impl)
  const adapterDir = path.join(data, 'adapter')
  const create = () => impl === 'claude'
    ? new ClaudeCodeAdapter({ dataDir: adapterDir, tmux, claudeBin: 'fixture-claude', claudeConfigPath: path.join(home, 'claude.json'), claudeProjectsDir: path.join(home, 'projects') })
    : new CodexWorkerAdapter({ dataDir: adapterDir, tmux, codexBin: 'fixture-codex', codexHomeSource: home, sessionDiscoveryTimeoutMs: 100 })
  const first = create(), restarted = create()
  try {
    await first.provision(workspace, { skills: [], mcp_servers: [] })
    const primary = await first.spawn({ worker_id: workerId, prompt: 'first task', workspace })
    expect(primary.initial_input?.disposition).toBe('accepted')
    await first.kill(primary)
    if (impl === 'codex') {
      const file = path.join(workspace.runtime_root!, '.codex/config.toml')
      const config = parseToml(await fs.readFile(file, 'utf8'))
      config.notify = ['obsolete-core-notify']
      await fs.writeFile(file, stringifyToml(config))
    }
    await first.dispose()
    const resumed = await restarted.resume(primary, 'continue task', { workspace })
    expect(resumed.seq).toBe(2)
    expect(resumed.initial_input?.disposition).toBe('accepted')
    if (impl === 'codex') {
      const config = parseToml(await fs.readFile(path.join(workspace.runtime_root!, '.codex/config.toml'), 'utf8'))
      expect(config.notify).not.toEqual(['obsolete-core-notify'])
      expect(JSON.stringify(config.notify)).toContain('events-cli.jsonl')
    }
    for (const launch of tmux.launches) {
      expect(launch.cwd).toBe(project)
      expect(launch.env![EVENTS_FILE_ENV]?.startsWith(workspace.runtime_root!)).toBe(true)
      if (impl === 'claude') {
        expect(launch.command).toContain(path.join(workspace.runtime_root!, '.mcp.json'))
        expect(launch.command).toContain('--settings')
        expect(launch.command).toContain('--plugin-dir')
      } else expect(launch.env!.CODEX_HOME).toBe(path.join(workspace.runtime_root!, '.codex'))
    }
    for (const seq of [1, 2]) expect(JSON.parse(await fs.readFile(path.join(adapterDir, workerId, `meta-${seq}.json`), 'utf8'))).toMatchObject({
      workspace_id: workspace.workspace_id, runtime_root: workspace.runtime_root, workspace_root: project,
    })
    expect(await fs.readdir(project)).toEqual(['AGENTS.md'])
    await restarted.kill(resumed)
    await fs.rm(workspace.runtime_root!, { recursive: true })
    await expect(restarted.resume(resumed, 'must not replace missing profile', { workspace })).rejects.toThrow()
    expect(tmux.launches).toHaveLength(2)
    await expect(fs.stat(workspace.runtime_root!)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await first.dispose(); await restarted.dispose() }
}, 30_000)
