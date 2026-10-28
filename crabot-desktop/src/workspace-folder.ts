import fs from 'node:fs/promises'
import path from 'node:path'
import { DesktopDirectorySelectionSchema, HttpClient, LoopbackAdminOriginSchema, WorkspaceClient, WorkspaceIdSchema } from 'crabot-client'
import { sameHostContext, type SessionHost } from './session-host.js'

/** Fixed native capability: business lookup stays on the authenticated shared HTTP contract. */
export async function revealWorkspaceFolder(host: Pick<SessionHost, 'context' | 'credential'>, workspaceId: string,
  openPath: (directory: string) => Promise<string>): Promise<boolean> {
  try {
    WorkspaceIdSchema.parse(workspaceId)
    const scope = host.context(), credential = await host.credential()
    if (!scope || !credential || !sameHostContext(scope, credential) || !LoopbackAdminOriginSchema.safeParse(credential.admin_url).success) return false
    const current = () => { const context = host.context(); return context !== null && sameHostContext(scope, context) }
    const client = new WorkspaceClient(new HttpClient({ endpoint: new URL('/api', credential.admin_url).href,
      token: () => { if (!current()) throw new Error('Desktop context changed'); return credential.token },
      fetch: (url, options) => { if (!current()) throw new Error('Desktop context changed'); return fetch(url, options) } }))
    const first = await client.get(workspaceId, { timeoutMs: 2000 })
    if (first.item.workspace.workspace_id !== workspaceId || first.item.directory_status !== 'ready' || !current()) return false
    const root = first.item.workspace.root, before = await fs.lstat(root, { bigint: true })
    if (before.ino === 0n || !before.isDirectory() || before.isSymbolicLink() || await fs.realpath(root) !== root) return false
    const checked = await client.get(workspaceId, { timeoutMs: 2000 })
    const after = await fs.lstat(root, { bigint: true })
    if (!current() || checked.item.workspace.workspace_id !== workspaceId || checked.item.directory_status !== 'ready' || checked.item.workspace.root !== root
      || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || await fs.realpath(root) !== root) return false
    return (await openPath(root)) === ''
  } catch { return false }
}


/** Selection only. The shared HTTP preview and explicit confirmation retain all business authority. */
export async function selectWorkspaceDirectory(host: Pick<SessionHost, 'context'>, choose: () => Promise<unknown>): Promise<string | null> {
  try {
    const original = host.context()
    if (!original) return null
    const selected = DesktopDirectorySelectionSchema.parse(await choose()), current = host.context()
    if (selected === null || !path.isAbsolute(selected) || !current || !sameHostContext(original, current)) return null
    return selected
  } catch { return null }
}
