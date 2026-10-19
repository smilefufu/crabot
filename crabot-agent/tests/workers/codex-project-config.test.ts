import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { assertCodexProjectConfiguration } from '../../src/workers/provision/codex-project-config.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-project-layer-'))); roots.push(root)
  const project = path.join(root, 'project'), home = path.join(root, 'native-home'), runtime = path.join(root, 'runtime')
  await fs.mkdir(path.join(project, '.codex'), { recursive: true }); await fs.mkdir(home); await fs.mkdir(runtime)
  const ws = { root: project, runtime_root: runtime, workspace_id: 'default' }
  return { root, project, home, runtime, ws, file: path.join(project, '.codex/config.toml') }
}
it('project MCP/hooks conflict is rejected read-only; empty/ordinary project settings remain usable', async () => {
  const f = await fixture()
  await assertCodexProjectConfiguration(f.ws, f.home)
  await fs.writeFile(f.file, 'model_reasoning_effort="high"\n')
  await assertCodexProjectConfiguration(f.ws, f.home)
  for (const text of ['[mcp_servers.unapproved]\ncommand="must-not-start"\n', 'notify=["must-not-start"]\n', '[hooks]\n', '[plugins]\n']) {
    await fs.writeFile(f.file, text)
    await expect(assertCodexProjectConfiguration(f.ws, f.home)).rejects.toThrow('覆盖Crabot管理')
    expect(await fs.readFile(f.file, 'utf8')).toBe(text)
  }
  expect(await fs.readdir(f.runtime)).toEqual([])
})
it('Admin provider connection cannot be replaced by a project; native-host project model preferences are retained', async () => {
  const f = await fixture(); await fs.writeFile(f.file, 'model_provider="project-provider"\n')
  await assertCodexProjectConfiguration(f.ws, f.home)
  await expect(assertCodexProjectConfiguration(f.ws, f.home, { CODEX_HOME: f.home })).rejects.toThrow('model_provider')
})
it('Git ancestor project configuration is checked while a non-Git parent is outside the native search scope', async () => {
  const f = await fixture(), child = path.join(f.project, 'child'); await fs.mkdir(child)
  await fs.writeFile(f.file, '[mcp_servers.unapproved]\ncommand="must-not-start"\n')
  const ws = { ...f.ws, root: child }
  await assertCodexProjectConfiguration(ws, f.home)
  await fs.mkdir(path.join(f.project, '.git'))
  await expect(assertCodexProjectConfiguration(ws, f.home)).rejects.toThrow('mcp_servers')
})
it('malformed project configuration never exposes text/credentials through a parser error', async () => {
  const f = await fixture(); await fs.writeFile(f.file, 'api_key="fixture-secret-unfinished')
  await expect(assertCodexProjectConfiguration(f.ws, f.home)).rejects.toThrow('无法解析')
  try { await assertCodexProjectConfiguration(f.ws, f.home) } catch (error) { expect(String(error)).not.toContain('fixture-secret') }
})
