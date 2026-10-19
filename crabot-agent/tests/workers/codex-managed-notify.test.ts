import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse as parseToml } from 'smol-toml'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { nativeEventChannel } from '../../src/workers/provision/native-runtime.js'

const selected = vi.hoisted(() => ({ bash: null as string | null }))
vi.mock('../../src/utils/resolve-bash-path.js', () => ({ resolveBashPath: () => selected.bash, BASH_NOT_FOUND_MESSAGE: 'Managed Bash unavailable' }))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-notify-中文 ' $path-")))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const data = path.join(root, 'data'), project = path.join(root, 'project'), home = path.join(root, 'home')
  for (const directory of [data, project, home]) await fs.mkdir(directory)
  const workspace = await new WorkspaceManager(path.join(data, 'workspaces'), data).resolve('worker-a', project)
  const adapter = new CodexWorkerAdapter({ dataDir: path.join(data, 'adapter'), codexHomeSource: home })
  cleanup.push(() => adapter.dispose())
  return { root, workspace, adapter }
}
it.skipIf(process.platform === 'win32')('notify actually runs the selected runtime Bash and cannot consume the caller stdin', async () => {
  const { root, workspace, adapter } = await fixture()
  selected.bash = path.join(root, 'selected bash')
  const evidence = path.join(root, 'interpreter-evidence')
  await fs.writeFile(selected.bash, '#!/bin/sh\nprintf "selected\\n" >> "$NOTIFY_INTERPRETER_EVIDENCE"\nexec /bin/bash "$@"\n', { mode: 0o700 })
  await adapter.provision(workspace, { skills: [], mcp_servers: [] })
  const config = parseToml(await fs.readFile(path.join(workspace.runtime_root!, '.codex/config.toml'), 'utf8')) as any
  // Intentionally leave stdin open: the hook must isolate its input from the native CLI.
  await promisify(execFile)(config.notify[0], config.notify.slice(1), { env: { ...process.env, NOTIFY_INTERPRETER_EVIDENCE: evidence }, timeout: 3000 })
  expect(await fs.readFile(evidence, 'utf8')).toBe('selected\n')
  expect((await nativeEventChannel(workspace, '.codex').readAll()).map(event => event.kind)).toEqual(['stop'])
})
it('missing selected runtime fails explicitly instead of writing a host-shell notification', async () => {
  selected.bash = null
  const { workspace, adapter } = await fixture()
  await expect(adapter.provision(workspace, { skills: [], mcp_servers: [] })).rejects.toThrow('Managed Bash unavailable')
  await expect(fs.stat(path.join(workspace.runtime_root!, '.codex/config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
})
