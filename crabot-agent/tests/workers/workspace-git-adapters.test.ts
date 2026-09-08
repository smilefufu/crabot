import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import { TmuxDriver, type TmuxSessionSpec } from '../../src/workers/tmux/driver.js'
import { WorkspaceGitInspector } from '../../src/workers/harness/workspace-git-inspector.js'
import { createWorkspaceGitMcpServerConfig, WORKSPACE_GIT_CONTEXT_ENV, WORKSPACE_GIT_MCP_SERVER_NAME } from '../../src/workers/workspace-git-capability.js'
import { workspaceGitContextFromEnv } from '../../src/mcp/workspace-git-stdio-server.js'

describe('native adapter Git binding assembly', () => {
  it.each(['claude-code', 'codex'] as const)('%s binds spawn and resume independently without putting the baseline in project config', async (impl) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'git-adapter-binding-'))
    const workspace = path.join(root, 'project')
    const nativeConfig = path.join(root, 'native-config')
    await fs.mkdir(workspace)
    await fs.mkdir(nativeConfig)
    const launches: TmuxSessionSpec[] = []
    class CaptureLaunch extends TmuxDriver {
      async newSession(spec: TmuxSessionSpec): Promise<never> { launches.push(spec); throw new Error('launch captured') }
    }
    const dataDir = path.join(root, 'workers')
    const tmux = new CaptureLaunch()
    const adapter = impl === 'claude-code'
      ? new ClaudeCodeAdapter({ dataDir, tmux, claudeBin: 'unused', claudeConfigPath: path.join(nativeConfig, 'claude.json') })
      : new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'unused', codexHomeSource: nativeConfig })
    try {
      const baseline = (await new WorkspaceGitInspector().inspect(workspace)).current
      const first = { worker_id: 'w-binding', incarnation_id: 'inc-first', workspace_root: workspace, baseline }
      await adapter.provision({ root: workspace }, { skills: [], mcp_servers: [createWorkspaceGitMcpServerConfig()] })
      const configText = await fs.readFile(path.join(workspace, impl === 'codex' ? '.codex/config.toml' : '.mcp.json'), 'utf8')
      expect(configText).not.toContain(baseline.captured_at)
      if (impl === 'codex') {
        const config = parseToml(configText) as any
        expect(config.mcp_servers[WORKSPACE_GIT_MCP_SERVER_NAME].env_vars).toEqual([WORKSPACE_GIT_CONTEXT_ENV])
      }
      await expect(adapter.spawn({ worker_id: first.worker_id, incarnation_id: first.incarnation_id,
        workspace: { root: workspace }, prompt: 'inspect', workspace_git: first })).rejects.toThrow('launch captured')
      expect(await workspaceGitContextFromEnv(launches[0].env!)).toEqual(first)
      const sessionId = randomUUID()
      if (impl === 'codex') {
        const sessions = path.join(workspace, '.codex', 'sessions')
        await fs.mkdir(sessions, { recursive: true })
        await fs.writeFile(path.join(sessions, `rollout-2026-09-08T00-00-00-${sessionId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n')
      }
      await fs.writeFile(path.join(dataDir, first.worker_id, 'meta-1.json'), JSON.stringify({
        seq: 1, incarnation_id: first.incarnation_id, state: 'exited', ended_reason: 'completed',
        session_id: sessionId, session_discovery: 'discovered',
        workspace_root: workspace, codex_home: path.join(workspace, '.codex'),
      }))
      const second = { ...first, incarnation_id: 'inc-second', baseline: (await new WorkspaceGitInspector().inspect(workspace)).current }
      await expect(adapter.resume({ worker_id: first.worker_id, seq: 1, session_ref: sessionId }, 'continue', {
        incarnation_id: second.incarnation_id, workspace_git: second,
      })).rejects.toThrow('launch captured')
      expect(await workspaceGitContextFromEnv(launches[1].env!)).toEqual(second)
      expect(await workspaceGitContextFromEnv(launches[0].env!)).toEqual(first)
      expect(launches[0].env![WORKSPACE_GIT_CONTEXT_ENV]).not.toBe(launches[1].env![WORKSPACE_GIT_CONTEXT_ENV])
    } finally {
      await adapter.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
