import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { defineTool } from '../../engine/index.js'
import type { ToolCallResult, ToolDefinition } from '../../engine/index.js'
import type { ResolvedPermissions } from '../../types.js'
import { AsyncMutex } from '../../workers/async-mutex.js'
import { BUILTIN_WORKER_PERMISSIONS, narrowWorkerPermissions } from '../../workers/builtin/runtime.js'
import type { WorkerContext } from '../../workers/harness/context-store.js'
import type { LedgerWorker, ManagerKey } from '../../workers/harness/ledger-types.js'
import type { LedgerStore } from '../../workers/harness/ledger-store.js'
import type { WakeEvent } from '../loop.js'

const MAX_READ_LINES = 400
const DEFAULT_READ_LINES = 200
const MAX_LIST_PAGE_SIZE = 100
const DEFAULT_LIST_PAGE_SIZE = 50
const MAX_SEARCH_MATCHES = 50
const DEFAULT_SEARCH_MATCHES = 20
const MAX_READ_FILE_BYTES = 1024 * 1024
const MAX_DECISION_BYTES = 64 * 1024
const DEFAULT_DECISION_DIR = 'docs/decisions'
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.pnpm-store', 'dist', 'build', 'coverage', '.next',
])
const DECISION_FILE = /^(\d{4})-(\d{2})-(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/
const decisionMutexes = new Map<string, AsyncMutex>()

export interface ProjectDocToolDeps {
  readonly ledger: Pick<LedgerStore, 'listWorkers' | 'findWorker'>
  readonly readWorkerContext: (workerId: string) => Promise<WorkerContext | undefined>
  readonly managerKey: ManagerKey
  readonly wakeEvent?: WakeEvent
}

interface MarkdownFile {
  readonly path: string
  readonly realPath: string
  readonly kind: 'file' | 'symlink'
  readonly size: number
}

function ok(value: unknown): ToolCallResult {
  return { output: JSON.stringify(value), isError: false }
}

function fail(tool: string, error: unknown): ToolCallResult {
  const message = error instanceof Error ? error.message : String(error)
  return { output: `${tool} 失败: ${message}`, isError: true }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function boundedInteger(value: unknown, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${field} 必须是 1 至 ${maximum} 的整数`)
  }
  return value as number
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertInside(root: string, target: string, label: string): void {
  if (!isInsideOrEqual(root, target)) throw new Error(`${label} 解析后越过项目根`)
}

function normalizeAbsoluteDirectoryPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`)
  if (value.includes('\0') || value !== value.trim() || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} 必须是规范化后的绝对路径`)
  }
  return value
}

function normalizeProjectRoot(value: unknown): string {
  return normalizeAbsoluteDirectoryPath(value, 'project_root')
}

function normalizeRelativePath(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  if (value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`${field} 必须是项目根内的相对路径`)
  }
  if (value === '' && allowEmpty) return ''
  if (value.trim() === '' || value !== value.trim()) throw new Error(`${field} 不是规范化相对路径`)
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${field} 不是规范化相对路径`)
  }
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
    throw new Error(`${field} 指向已排除的生成或依赖目录`)
  }
  return segments.join(path.sep)
}

function protocolPath(nativePath: string): string {
  return nativePath.split(path.sep).join('/')
}

function assertMarkdownPath(relativePath: string, field = 'path'): void {
  if (path.extname(relativePath).toLowerCase() !== '.md') throw new Error(`${field} 必须指向 Markdown 文件`)
}

async function realDirectory(value: string, label: string): Promise<string> {
  let resolved: string
  try {
    resolved = await fs.realpath(value)
  } catch (error) {
    throw new Error(`${label} 无法解析: ${(error as Error).message}`)
  }
  const stat = await fs.stat(resolved)
  if (!stat.isDirectory()) throw new Error(`${label} 不是目录`)
  return resolved
}

function mainlineWorkspace(worker: LedgerWorker, seq?: number): string {
  const incarnation = seq === undefined
    ? worker.incarnations.filter((entry) => entry.forked_from === undefined).at(-1)
    : worker.incarnations.find((entry) => entry.seq === seq)
  if (!incarnation) throw new Error(`来源 Worker 缺少对应化身 workspace`)
  return incarnation.workspace
}

function permissionsFromWake(wakeEvent: WakeEvent | undefined): ResolvedPermissions | undefined {
  if (
    wakeEvent?.kind === 'human_messages' ||
    wakeEvent?.kind === 'attention_flush' ||
    wakeEvent?.kind === 'schedule'
  ) {
    return wakeEvent.principalPermissions
  }
  return undefined
}

async function authorizeProjectRoot(
  deps: ProjectDocToolDeps,
  rawProjectRoot: unknown,
  write: boolean,
): Promise<string> {
  const wake = deps.wakeEvent
  if (wake?.kind === 'worker_event') {
    const found = await deps.ledger.findWorker(wake.event.worker_id)
    if (!found || found.managerKey !== deps.managerKey || found.worker.manager_key !== deps.managerKey) {
      throw new Error('来源 Worker 不属于当前会话，项目权限已拒绝')
    }
    const persisted = await deps.readWorkerContext(found.worker.worker_id)
    const effective = narrowWorkerPermissions(
      BUILTIN_WORKER_PERMISSIONS,
      persisted?.principal_permissions ?? null,
    )
    if (!effective.tool_access.file_io) throw new Error('来源 Worker 没有 file_io 权限')

    const requested = await realDirectory(normalizeProjectRoot(rawProjectRoot), 'project_root')
    const workspace = await realDirectory(
      normalizeAbsoluteDirectoryPath(mainlineWorkspace(found.worker, wake.event.seq), '来源 Worker workspace'),
      '来源 Worker workspace',
    )
    if (requested !== workspace) throw new Error('Worker 事件只能访问来源 Worker 自己的 workspace')
    return requested
  }

  const permissions = permissionsFromWake(wake)
  if (!permissions) throw new Error('当前处理回合没有可用的主体权限快照')
  if (!permissions.tool_access.file_io) throw new Error('当前处理回合主体没有 file_io 权限')
  if (write && permissions.storage?.access !== 'readwrite' && permissions.storage !== null) {
    throw new Error('当前处理回合主体的 storage 不是 readwrite')
  }

  const requested = await realDirectory(normalizeProjectRoot(rawProjectRoot), 'project_root')
  if (permissions.storage) {
    const storageRoot = await realDirectory(
      normalizeAbsoluteDirectoryPath(permissions.storage.workspace_path, 'storage.workspace_path'),
      'storage.workspace_path',
    )
    assertInside(storageRoot, requested, 'project_root')
    return requested
  }

  const workers = await deps.ledger.listWorkers(deps.managerKey)
  for (const worker of workers) {
    for (const incarnation of worker.incarnations) {
      try {
        const workspace = normalizeAbsoluteDirectoryPath(incarnation.workspace, 'Worker workspace')
        if (await realDirectory(workspace, 'Worker workspace') === requested) return requested
      } catch {
        // 已删除的历史 workspace 不产生授权，也不阻断其它真实匹配项。
      }
    }
  }
  throw new Error('storage 未配置，project_root 未精确匹配当前会话已有 Worker workspace')
}

async function resolveExisting(root: string, relativePath: string): Promise<{
  readonly logicalPath: string
  readonly realPath: string
  readonly kind: 'file' | 'symlink'
  readonly stat: { isFile(): boolean; isDirectory(): boolean; size: number }
}> {
  let current = root
  for (const segment of relativePath.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment)
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      throw new Error(`path 中间目录不存在或不可读: ${(error as Error).message}`)
    }
    if (stat.isSymbolicLink()) throw new Error('path 不能经过目录软链接')
    if (!stat.isDirectory()) throw new Error('path 的中间层不是目录')
  }

  const logicalPath = path.join(root, relativePath)
  let linkStat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    linkStat = await fs.lstat(logicalPath)
  } catch (error) {
    throw new Error(`path 不存在或不可读: ${(error as Error).message}`)
  }
  let realPath: string
  try {
    realPath = await fs.realpath(logicalPath)
  } catch (error) {
    throw new Error(`path 是悬空或循环软链接: ${(error as Error).message}`)
  }
  assertInside(root, realPath, 'path')
  const stat = await fs.stat(realPath)
  return { logicalPath, realPath, kind: linkStat.isSymbolicLink() ? 'symlink' : 'file', stat }
}

async function markdownFile(root: string, relativePath: string): Promise<MarkdownFile> {
  assertMarkdownPath(relativePath)
  const resolved = await resolveExisting(root, relativePath)
  if (!resolved.stat.isFile()) throw new Error('path 目标不是普通文件')
  return {
    path: protocolPath(relativePath),
    realPath: resolved.realPath,
    kind: resolved.kind,
    size: resolved.stat.size,
  }
}

async function listMarkdownFiles(root: string, scope: string): Promise<MarkdownFile[]> {
  if (scope !== '') {
    const resolved = await resolveExisting(root, scope)
    if (resolved.stat.isFile()) return [await markdownFile(root, scope)]
    if (!resolved.stat.isDirectory()) throw new Error('path 目标既不是 Markdown 文件也不是目录')
    if (resolved.kind === 'symlink') throw new Error('list/search 范围不能是目录软链接')
  }

  const found: MarkdownFile[] = []
  const walk = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = path.join(root, relativeDirectory)
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
      const relative = relativeDirectory === '' ? entry.name : path.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        await walk(relative)
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
        const stat = await fs.stat(path.join(root, relative))
        found.push({ path: protocolPath(relative), realPath: path.join(root, relative), kind: 'file', size: stat.size })
      } else if (entry.isSymbolicLink() && path.extname(entry.name).toLowerCase() === '.md') {
        found.push(await markdownFile(root, relative))
      }
    }
  }

  await walk(scope)
  return found.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function textLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

async function readMarkdown(root: string, relativePath: string, startLine: number, maxLines: number) {
  const file = await markdownFile(root, relativePath)
  if (file.size > MAX_READ_FILE_BYTES) throw new Error('Markdown 文件超过 1 MiB，拒绝读取')
  const body = await fs.readFile(file.realPath, 'utf-8')
  const lines = textLines(body)
  const content = lines.slice(startLine - 1, startLine - 1 + maxLines)
  return {
    operation: 'read' as const,
    path: file.path,
    start_line: startLine,
    end_line: content.length === 0 ? Math.min(startLine - 1, lines.length) : startLine + content.length - 1,
    total_lines: lines.length,
    digest: sha256(body),
    content: content.join('\n'),
  }
}

async function searchMarkdown(root: string, scope: string, query: string, limit: number) {
  const files = await listMarkdownFiles(root, scope)
  const matches: Array<{ path: string; line: number; text: string }> = []
  const needle = query.toLowerCase()
  let truncated = false

  outer: for (const file of files) {
    const reader = createInterface({ input: createReadStream(file.realPath, { encoding: 'utf-8' }), crlfDelay: Infinity })
    let line = 0
    try {
      for await (const text of reader) {
        line += 1
        if (!text.toLowerCase().includes(needle)) continue
        if (matches.length === limit) {
          truncated = true
          break outer
        }
        matches.push({ path: file.path, line, text: Array.from(text).slice(0, 500).join('') })
      }
    } finally {
      reader.close()
    }
  }
  return { operation: 'search' as const, matches, truncated }
}

function validateDecisionFileName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('file_name 必须是字符串')
  const match = DECISION_FILE.exec(value)
  if (!match) throw new Error('file_name 必须符合 YYYY-MM-DD-decision-abstract.md')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('file_name 中的日期无效')
  }
  return value
}

function validateDecisionContent(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('content 必须是非空 Markdown')
  if (Buffer.byteLength(value, 'utf-8') > MAX_DECISION_BYTES) throw new Error('content 不得超过 64 KiB')
  if (!/^#\s+\S/m.test(value)) throw new Error('content 至少包含一个一级标题')
  return value
}

async function ensureDefaultDecisionDirectory(root: string): Promise<string> {
  let current = root
  for (const segment of DEFAULT_DECISION_DIR.split('/')) {
    const next = path.join(current, segment)
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        await fs.mkdir(next)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
      stat = await fs.lstat(next)
    }
    if (stat.isSymbolicLink()) throw new Error('decision_dir 不能经过目录软链接')
    if (!stat.isDirectory()) throw new Error('decision_dir 目标不是目录')
    const real = await fs.realpath(next)
    assertInside(root, real, 'decision_dir')
    current = next
  }
  return fs.realpath(path.join(root, DEFAULT_DECISION_DIR))
}

async function decisionDirectory(root: string, raw: unknown, allowCreateDefault: boolean): Promise<{
  readonly relative: string
  readonly real: string
}> {
  const requested = raw === undefined ? DEFAULT_DECISION_DIR : normalizeRelativePath(raw, 'decision_dir')
  const relative = protocolPath(requested)
  if (allowCreateDefault && relative === DEFAULT_DECISION_DIR) {
    return { relative, real: await ensureDefaultDecisionDirectory(root) }
  }
  const resolved = await resolveExisting(root, requested)
  if (!resolved.stat.isDirectory()) throw new Error('decision_dir 目标不是目录')
  if (resolved.kind === 'symlink') throw new Error('decision_dir 不能是目录软链接')
  return { relative, real: resolved.realPath }
}

function decisionMutex(target: string): AsyncMutex {
  let mutex = decisionMutexes.get(target)
  if (!mutex) {
    mutex = new AsyncMutex()
    decisionMutexes.set(target, mutex)
  }
  return mutex
}

async function createDecision(target: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`)
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf-8', flag: 'wx', mode: 0o644 })
    await fs.link(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function updateDecision(target: string, content: string, expectedDigest: unknown): Promise<void> {
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('update 必须提供合法 expected_digest')
  }
  let linkStat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    linkStat = await fs.lstat(target)
  } catch (error) {
    throw new Error(`待更新决策文件不存在: ${(error as Error).message}`)
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw new Error('待更新决策必须是普通 Markdown 文件')
  const previous = await fs.readFile(target)
  if (sha256(previous) !== expectedDigest) throw new Error('expected_digest 不匹配，决策文件已被并发修改')

  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`)
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf-8', flag: 'wx', mode: 0o644 })
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export function buildProjectDocTools(deps: ProjectDocToolDeps): ToolDefinition[] {
  const inspect = defineTool({
    name: 'inspect_project_docs',
    description: '在本处理回合有权访问的项目根内，按需列举、分段读取或字面搜索 Markdown 项目文档。',
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: '项目 workspace root 的规范化绝对路径' },
        operation: { type: 'string', enum: ['list', 'read', 'search'] },
        path: { type: 'string', description: '项目根下的相对 Markdown 路径；list/search 可用目录范围' },
        query: { type: 'string', description: 'search 必填的不区分大小写字面查询' },
        start_line: { type: 'integer', minimum: 1, description: 'read 默认 1' },
        max_lines: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, description: 'read 默认 200，最大 400' },
        page: { type: 'integer', minimum: 1, description: 'list 默认 1' },
        page_size: { type: 'integer', minimum: 1, maximum: MAX_LIST_PAGE_SIZE, description: 'list 默认 50，最大 100' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_MATCHES, description: 'search 默认 20，最大 50' },
      },
      required: ['project_root', 'operation'],
      additionalProperties: false,
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      try {
        if (!hasOnlyKeys(input, ['project_root', 'operation', 'path', 'query', 'start_line', 'max_lines', 'page', 'page_size', 'limit'])) {
          throw new Error('包含未定义字段')
        }
        const root = await authorizeProjectRoot(deps, input.project_root, false)
        if (input.operation === 'list') {
          if (!hasOnlyKeys(input, ['project_root', 'operation', 'path', 'page', 'page_size'])) throw new Error('list 包含无关参数')
          const scope = input.path === undefined ? '' : normalizeRelativePath(input.path, 'path', true)
          const page = boundedInteger(input.page, 1, Number.MAX_SAFE_INTEGER, 'page')
          const pageSize = boundedInteger(input.page_size, DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE, 'page_size')
          const files = await listMarkdownFiles(root, scope)
          const offset = (page - 1) * pageSize
          return ok({
            operation: 'list',
            items: files.slice(offset, offset + pageSize).map(({ path: filePath, kind, size }) => ({ path: filePath, kind, size })),
            pagination: {
              page,
              page_size: pageSize,
              total_items: files.length,
              total_pages: Math.ceil(files.length / pageSize),
            },
          })
        }
        if (input.operation === 'read') {
          if (!hasOnlyKeys(input, ['project_root', 'operation', 'path', 'start_line', 'max_lines'])) throw new Error('read 包含无关参数')
          const relative = normalizeRelativePath(input.path, 'path')
          const startLine = boundedInteger(input.start_line, 1, Number.MAX_SAFE_INTEGER, 'start_line')
          const maxLines = boundedInteger(input.max_lines, DEFAULT_READ_LINES, MAX_READ_LINES, 'max_lines')
          return ok(await readMarkdown(root, relative, startLine, maxLines))
        }
        if (input.operation === 'search') {
          if (!hasOnlyKeys(input, ['project_root', 'operation', 'path', 'query', 'limit'])) throw new Error('search 包含无关参数')
          const scope = input.path === undefined ? '' : normalizeRelativePath(input.path, 'path', true)
          if (typeof input.query !== 'string' || input.query.trim() === '') throw new Error('search.query 必须是非空字符串')
          const limit = boundedInteger(input.limit, DEFAULT_SEARCH_MATCHES, MAX_SEARCH_MATCHES, 'limit')
          return ok(await searchMarkdown(root, scope, input.query, limit))
        }
        throw new Error('operation 必须是 list、read 或 search')
      } catch (error) {
        return fail('inspect_project_docs', error)
      }
    },
  })

  const manage = defineTool({
    name: 'manage_decision_doc',
    description: '在已授权项目的决策目录中排他创建决策记录，或依据读取到的完整 digest 更新普通 Markdown。',
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: '项目 workspace root 的规范化绝对路径' },
        action: { type: 'string', enum: ['create', 'update'] },
        decision_dir: { type: 'string', description: '默认 docs/decisions；其它目录必须已经存在' },
        file_name: { type: 'string', pattern: DECISION_FILE.source, description: 'YYYY-MM-DD-decision-abstract.md' },
        content: { type: 'string', maxLength: MAX_DECISION_BYTES, description: '完整 Markdown，最大 64 KiB' },
        expected_digest: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'update 必填，来自 inspect_project_docs read' },
      },
      required: ['project_root', 'action', 'file_name', 'content'],
      additionalProperties: false,
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      try {
        if (!hasOnlyKeys(input, ['project_root', 'action', 'decision_dir', 'file_name', 'content', 'expected_digest'])) {
          throw new Error('包含未定义字段')
        }
        if (input.action !== 'create' && input.action !== 'update') throw new Error('action 必须是 create 或 update')
        if (input.action === 'create' && input.expected_digest !== undefined) throw new Error('create 不接受 expected_digest')
        const fileName = validateDecisionFileName(input.file_name)
        const content = validateDecisionContent(input.content)
        const root = await authorizeProjectRoot(deps, input.project_root, true)
        const directory = await decisionDirectory(root, input.decision_dir, input.action === 'create')
        const target = path.join(directory.real, fileName)
        assertInside(root, target, '决策文件')

        return await decisionMutex(target).run(async () => {
          if (input.action === 'create') await createDecision(target, content)
          else await updateDecision(target, content, input.expected_digest)
          return ok({
            action: input.action === 'create' ? 'created' : 'updated',
            path: `${directory.relative}/${fileName}`,
            digest: sha256(content),
          })
        })
      } catch (error) {
        return fail('manage_decision_doc', error)
      }
    },
  })

  return [inspect, manage]
}
