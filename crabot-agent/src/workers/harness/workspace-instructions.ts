import { createHash, randomUUID } from 'crypto'
import { promises as fs, type Dirent } from 'fs'
import { dirname, join } from 'path'

import { AsyncMutex } from '../async-mutex.js'
import type { WorkspaceInstructionSnapshot } from '../types.js'

export type { WorkspaceInstructionSnapshot } from '../types.js'

export interface CapturedWorkspaceInstructions {
  readonly snapshot: WorkspaceInstructionSnapshot
  readonly text?: string
}

interface LegacyManagedClaudeBridge {
  readonly workspace_root: string
  readonly claude_path: string
  readonly kind: 'symlink' | 'hardlink' | 'snapshot_copy'
}

type InstructionEntry =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly stat: Awaited<ReturnType<typeof fs.lstat>> }
  | { readonly kind: 'symlink'; readonly realPath: string }

const LEGACY_BRIDGE_SUFFIX = '.claude-bridge.json'
const workspaceMutexes = new Map<string, AsyncMutex>()

function artifactPath(workersDir: string, workerId: string, incarnationId: string): string {
  return join(workersDir, workerId, 'workspace-instructions', `${incarnationId}.md`)
}

function mutexFor(workspaceRoot: string): AsyncMutex {
  let mutex = workspaceMutexes.get(workspaceRoot)
  if (!mutex) {
    mutex = new AsyncMutex()
    workspaceMutexes.set(workspaceRoot, mutex)
  }
  return mutex
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

async function inspectInstructionEntry(path: string, name: string): Promise<InstructionEntry> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw new Error(`${name} 无法检查: ${(error as Error).message}`)
  }
  if (stat.isFile()) return { kind: 'file', stat }
  if (!stat.isSymbolicLink()) throw new Error(`${name} 必须是普通文件或软链接`)

  let realPath: string
  try {
    realPath = await fs.realpath(path)
  } catch (error) {
    throw new Error(`${name} 是悬空或循环软链接: ${(error as Error).message}`)
  }
  let targetStat: Awaited<ReturnType<typeof fs.stat>>
  try {
    targetStat = await fs.stat(realPath)
  } catch (error) {
    throw new Error(`${name} 目标无法读取: ${(error as Error).message}`)
  }
  if (!targetStat.isFile()) throw new Error(`${name} 的软链接目标不是普通文件`)
  return { kind: 'symlink', realPath }
}

function isLegacyBridge(value: unknown): value is LegacyManagedClaudeBridge {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.workspace_root === 'string' &&
    typeof record.claude_path === 'string' &&
    (record.kind === 'symlink' || record.kind === 'hardlink' || record.kind === 'snapshot_copy')
}

async function readDirectory(path: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function provesLegacyClaudeOwnership(params: {
  readonly workersDir: string
  readonly workspaceRoot: string
  readonly agents: Extract<InstructionEntry, { kind: 'file' }>
  readonly claude: Extract<InstructionEntry, { kind: 'file' }>
}): Promise<boolean> {
  const claudePath = join(params.workspaceRoot, 'CLAUDE.md')
  const workerDirectories = await readDirectory(params.workersDir)
  for (const workerDirectory of workerDirectories) {
    if (!workerDirectory.isDirectory()) continue
    const instructionsDir = join(params.workersDir, workerDirectory.name, 'workspace-instructions')
    const records = await readDirectory(instructionsDir)
    for (const entry of records) {
      if (!entry.isFile() || !entry.name.endsWith(LEGACY_BRIDGE_SUFFIX)) continue
      let record: unknown
      try {
        record = JSON.parse(await fs.readFile(join(instructionsDir, entry.name), 'utf-8'))
      } catch {
        continue
      }
      if (!isLegacyBridge(record) || record.workspace_root !== params.workspaceRoot || record.claude_path !== claudePath) {
        continue
      }
      if (
        record.kind === 'hardlink' &&
        params.agents.stat.dev === params.claude.stat.dev &&
        params.agents.stat.ino === params.claude.stat.ino
      ) {
        return true
      }
      if (record.kind === 'snapshot_copy') {
        const incarnationId = entry.name.slice(0, -LEGACY_BRIDGE_SUFFIX.length)
        try {
          const [artifact, currentClaude] = await Promise.all([
            fs.readFile(join(instructionsDir, `${incarnationId}.md`)),
            fs.readFile(claudePath),
          ])
          if (artifact.equals(currentClaude)) return true
        } catch {
          // 缺失或已损坏的旧 artifact 不能证明 workspace 文件所有权。
        }
      }
    }
  }
  return false
}

async function createRelativeLink(targetName: 'AGENTS.md' | 'CLAUDE.md', linkPath: string): Promise<void> {
  try {
    await fs.symlink(targetName, linkPath, 'file')
  } catch (error) {
    throw new Error(`无法创建长期相对软链接 ${linkPath} -> ${targetName}: ${(error as Error).message}`)
  }
}

async function migrateLegacyClaudeBridge(workspaceRoot: string): Promise<void> {
  const claudePath = join(workspaceRoot, 'CLAUDE.md')
  const backup = join(workspaceRoot, `.CLAUDE.md.crabot-migrate-${randomUUID()}`)
  await fs.rename(claudePath, backup)
  try {
    await createRelativeLink('AGENTS.md', claudePath)
  } catch (error) {
    await fs.rename(backup, claudePath)
    throw error
  }
  await fs.rm(backup)
}

async function normalizeWorkspaceInstructionEntries(workersDir: string, workspaceRoot: string): Promise<boolean> {
  let rootStat: Awaited<ReturnType<typeof fs.stat>>
  try {
    rootStat = await fs.stat(workspaceRoot)
  } catch (error) {
    throw new Error(`workspace root 无法读取: ${(error as Error).message}`)
  }
  if (!rootStat.isDirectory()) throw new Error('workspace root 不是目录')

  const agentsPath = join(workspaceRoot, 'AGENTS.md')
  const claudePath = join(workspaceRoot, 'CLAUDE.md')
  const [agents, claude] = await Promise.all([
    inspectInstructionEntry(agentsPath, 'AGENTS.md'),
    inspectInstructionEntry(claudePath, 'CLAUDE.md'),
  ])

  if (agents.kind === 'missing' && claude.kind === 'missing') return false
  if (agents.kind === 'file' && claude.kind === 'missing') {
    await createRelativeLink('AGENTS.md', claudePath)
    return true
  }
  if (agents.kind === 'missing' && claude.kind === 'file') {
    await createRelativeLink('CLAUDE.md', agentsPath)
    return true
  }
  if (agents.kind === 'symlink' && claude.kind === 'file') {
    if (agents.realPath !== await fs.realpath(claudePath)) throw new Error('AGENTS.md 软链接没有指向 CLAUDE.md')
    return true
  }
  if (agents.kind === 'file' && claude.kind === 'symlink') {
    if (claude.realPath !== await fs.realpath(agentsPath)) throw new Error('CLAUDE.md 软链接没有指向 AGENTS.md')
    return true
  }
  if (agents.kind === 'file' && claude.kind === 'file') {
    if (!await provesLegacyClaudeOwnership({ workersDir, workspaceRoot, agents, claude })) {
      throw new Error('AGENTS.md 与 CLAUDE.md 是两份独立正文，无法自动确定权威来源')
    }
    await migrateLegacyClaudeBridge(workspaceRoot)
    return true
  }
  throw new Error('AGENTS.md 与 CLAUDE.md 必须由一份普通正文和指向它的有效软链接组成')
}

/**
 * 每个新化身启动前先把 AGENTS.md/CLAUDE.md 规范化成一份正文，再抓取不可变 AGENTS.md 快照。
 * 新建的相对软链接属于项目长期产物，不随化身结束或失败清理。
 */
export async function captureWorkspaceInstructions(params: {
  readonly workersDir: string
  readonly workerId: string
  readonly incarnationId: string
  readonly workspaceRoot: string
  readonly capturedAt: string
}): Promise<CapturedWorkspaceInstructions> {
  return mutexFor(params.workspaceRoot).run(async () => {
    const present = await normalizeWorkspaceInstructionEntries(params.workersDir, params.workspaceRoot)
    if (!present) return { snapshot: { source: 'absent', captured_at: params.capturedAt } }

    let text: string
    try {
      text = await fs.readFile(join(params.workspaceRoot, 'AGENTS.md'), 'utf-8')
    } catch (error) {
      throw new Error(`AGENTS.md 正文无法读取: ${(error as Error).message}`)
    }
    const digest = createHash('sha256').update(text).digest('hex')
    const artifactId = `workspace-instructions/${params.workerId}/${params.incarnationId}`
    await writeAtomic(artifactPath(params.workersDir, params.workerId, params.incarnationId), text)
    return {
      snapshot: { source: 'agents_md', captured_at: params.capturedAt, digest, artifact_id: artifactId },
      text,
    }
  })
}
