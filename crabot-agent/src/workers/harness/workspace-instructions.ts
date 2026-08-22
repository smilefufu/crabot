import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { WorkspaceInstructionSnapshot } from '../types.js'

export type { WorkspaceInstructionSnapshot } from '../types.js'

export interface CapturedWorkspaceInstructions {
  readonly snapshot: WorkspaceInstructionSnapshot
  readonly text?: string
}

export type ClaudeWorkspaceBridge =
  | { readonly kind: 'symlink' | 'hardlink' | 'snapshot_copy'; readonly managed: true }
  | { readonly kind: 'not_needed' | 'user_owned_claude_md'; readonly managed: false }

interface ManagedClaudeBridge {
  readonly workspace_root: string
  readonly claude_path: string
  readonly kind: Extract<ClaudeWorkspaceBridge, { managed: true }>['kind']
}

function artifactPath(workersDir: string, workerId: string, incarnationId: string): string {
  return join(workersDir, workerId, 'workspace-instructions', `${incarnationId}.md`)
}

function bridgePath(workersDir: string, workerId: string, incarnationId: string): string {
  return join(workersDir, workerId, 'workspace-instructions', `${incarnationId}.claude-bridge.json`)
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  await fs.mkdir(dirname(path), { recursive: true })
  try {
    await fs.writeFile(tmp, contents, { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, path)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Harness reads AGENTS.md once per incarnation and keeps the immutable body outside the workspace.
 * It deliberately does not create, normalize, or otherwise modify the user-owned source file.
 */
export async function captureWorkspaceInstructions(params: {
  readonly workersDir: string
  readonly workerId: string
  readonly incarnationId: string
  readonly workspaceRoot: string
  readonly capturedAt: string
}): Promise<CapturedWorkspaceInstructions> {
  let text: string
  try {
    text = await fs.readFile(join(params.workspaceRoot, 'AGENTS.md'), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { snapshot: { source: 'absent', captured_at: params.capturedAt } }
    }
    throw error
  }

  const digest = createHash('sha256').update(text).digest('hex')
  const artifactId = `workspace-instructions/${params.workerId}/${params.incarnationId}`
  await writeAtomic(artifactPath(params.workersDir, params.workerId, params.incarnationId), text)
  return {
    snapshot: { source: 'agents_md', captured_at: params.capturedAt, digest, artifact_id: artifactId },
    text,
  }
}

/**
 * Claude Code discovers CLAUDE.md rather than AGENTS.md. The bridge is created only when no
 * user-owned CLAUDE.md exists, and its ownership record lives in Harness private storage.
 */
export async function prepareClaudeWorkspaceBridge(params: {
  readonly workersDir: string
  readonly workerId: string
  readonly incarnationId: string
  readonly workspaceRoot: string
  readonly instructions: CapturedWorkspaceInstructions
}): Promise<ClaudeWorkspaceBridge> {
  if (params.instructions.snapshot.source === 'absent') return { kind: 'not_needed', managed: false }

  const claudePath = join(params.workspaceRoot, 'CLAUDE.md')
  try {
    await fs.lstat(claudePath)
    return { kind: 'user_owned_claude_md', managed: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const agentsPath = join(params.workspaceRoot, 'AGENTS.md')
  let kind: Extract<ClaudeWorkspaceBridge, { managed: true }>['kind']
  try {
    await fs.symlink('AGENTS.md', claudePath, 'file')
    kind = 'symlink'
  } catch {
    try {
      await fs.link(agentsPath, claudePath)
      kind = 'hardlink'
    } catch {
      await fs.copyFile(agentsPath, claudePath)
      kind = 'snapshot_copy'
    }
  }

  await writeAtomic(bridgePath(params.workersDir, params.workerId, params.incarnationId), JSON.stringify({
    workspace_root: params.workspaceRoot,
    claude_path: claudePath,
    kind,
  } satisfies ManagedClaudeBridge))
  return { kind, managed: true }
}

/** Remove only a bridge that this Harness incarnation recorded as its own artifact. */
export async function cleanupClaudeWorkspaceBridge(params: {
  readonly workersDir: string
  readonly workerId: string
  readonly incarnationId: string
  readonly workspaceRoot: string
}): Promise<void> {
  const path = bridgePath(params.workersDir, params.workerId, params.incarnationId)
  let record: ManagedClaudeBridge
  try {
    record = JSON.parse(await fs.readFile(path, 'utf-8')) as ManagedClaudeBridge
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (record.workspace_root !== params.workspaceRoot || record.claude_path !== join(params.workspaceRoot, 'CLAUDE.md')) {
    throw new Error('workspace instruction bridge record does not match requested workspace')
  }
  await fs.rm(record.claude_path, { force: true })
  await fs.rm(path, { force: true })
}
