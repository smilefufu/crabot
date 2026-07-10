import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { ToolCallResult, ToolDefinition } from '../engine/types.js'
import { byteLength, truncateUtf8 } from '../engine/byte-cap.js'

export interface TmpPageToolsDeps {
  readonly dataDir: string
  readonly getTmpPageBaseUrl: () => string | undefined
  readonly taskId: string
  readonly now?: () => Date
  readonly randomBytes?: (size: number) => Buffer
  /** 内部 tmp-page server.cjs 路径。 */
  readonly serverScriptPath?: string
  readonly tmpPagePort?: number
  readonly serverStartupTimeoutMs?: number
  readonly serverProbeIntervalMs?: number
  /** 测试或宿主可替换的 server 启动保障。 */
  readonly ensureServer?: () => Promise<void> | void
}

interface TmpPageMeta {
  readonly created_at: string
  readonly title: string
  readonly owner_task_id: string
  readonly expires_at: string
  readonly mode: 'single' | 'multi'
}

interface TmpPageEvent {
  readonly event_id: number
  readonly at: string
  readonly data: unknown
  readonly trusted: false
}

const PAGE_ID_RE = /^[A-Za-z0-9_-]{16,}$/
const DEFAULT_TTL_SECONDS = 24 * 60 * 60
const MIN_TTL_SECONDS = 60
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_TMP_PAGE_PORT = 19099
const DEFAULT_SERVER_STARTUP_TIMEOUT_MS = 5_000
const DEFAULT_SERVER_PROBE_INTERVAL_MS = 50
const MAX_READ_EVENTS_OUTPUT_BYTES = 200_000
const MAX_SINGLE_EVENT_BYTES = 40_000
const MAX_EVENT_PREVIEW_BYTES = 8_000
const serverStartPromises = new Map<string, Promise<void>>()

function ok(data: unknown): ToolCallResult {
  return { isError: false, output: JSON.stringify(data) }
}

function fail(error_code: string, extra: Record<string, unknown> = {}): ToolCallResult {
  return { isError: true, output: JSON.stringify({ success: false, error_code, ...extra }) }
}

function clampTtl(input: number | undefined): number {
  if (input === undefined) return DEFAULT_TTL_SECONDS
  return Math.min(Math.max(Math.trunc(input), MIN_TTL_SECONDS), MAX_TTL_SECONDS)
}

function isValidTtl(input: unknown): boolean {
  return input === undefined || (typeof input === 'number' && Number.isFinite(input))
}

function pageIdFrom(input: unknown): string | undefined {
  return typeof input === 'string' && PAGE_ID_RE.test(input) ? input : undefined
}

function pagesRoot(dataDir: string): string {
  return path.join(dataDir, 'tmp-pages')
}

function pageDir(dataDir: string, pageId: string): string {
  return path.join(pagesRoot(dataDir), pageId)
}

function expiresAt(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString()
}

function pageUrl(base: string, pageId: string): string {
  return `${base.replace(/\/+$/, '')}/tmp-pages/${pageId}`
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, filePath)
}

async function readMeta(dir: string): Promise<TmpPageMeta | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as TmpPageMeta
  } catch {
    return undefined
  }
}

function makePageId(deps: TmpPageToolsDeps): string {
  return (deps.randomBytes ?? nodeRandomBytes)(16).toString('hex')
}

function getBaseUrl(deps: TmpPageToolsDeps): string | undefined {
  const base = deps.getTmpPageBaseUrl()?.trim()
  return base ? base.replace(/\/+$/, '') : undefined
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data)
  } catch {
    return JSON.stringify(String(data))
  }
}

function eventJsonBytes(event: TmpPageEvent): number {
  return byteLength(safeJson(event))
}

function fitEventForOutput(event: TmpPageEvent): TmpPageEvent {
  if (eventJsonBytes(event) <= MAX_SINGLE_EVENT_BYTES) return event
  const originalType = Array.isArray(event.data) ? 'array' : typeof event.data
  const raw = typeof event.data === 'string' ? event.data : safeJson(event.data)
  let previewBytes = MAX_EVENT_PREVIEW_BYTES
  let fitted: TmpPageEvent = {
    ...event,
    data: {
      truncated: true,
      original_type: originalType,
      preview: truncateUtf8(raw, previewBytes),
    },
  }
  while (eventJsonBytes(fitted) > MAX_SINGLE_EVENT_BYTES && previewBytes > 256) {
    previewBytes = Math.floor(previewBytes / 2)
    fitted = {
      ...event,
      data: {
        truncated: true,
        original_type: originalType,
        preview: truncateUtf8(raw, previewBytes),
      },
    }
  }
  return fitted
}

function readEventsOutputBytes(page_id: string, events: TmpPageEvent[], next_after_event_id: number): number {
  return byteLength(JSON.stringify({ page_id, events, next_after_event_id }))
}

function defaultServerScriptPath(): string {
  const crabotHome = process.env.CRABOT_HOME ?? path.resolve(__dirname, '../../..')
  return path.join(crabotHome, 'crabot-admin', 'builtins', 'skills', 'tmp-page', 'scripts', 'server.cjs')
}

function tmpPagePort(deps: TmpPageToolsDeps): number {
  if (deps.tmpPagePort !== undefined) return deps.tmpPagePort
  const envPort = Number.parseInt(process.env.CRABOT_TMP_PAGE_PORT ?? '', 10)
  return Number.isFinite(envPort) ? envPort : DEFAULT_TMP_PAGE_PORT
}

async function openTmpPageServerLog(dataDir: string) {
  const logDir = path.join(dataDir, 'logs')
  await mkdir(logDir, { recursive: true })
  return open(path.join(logDir, 'tmp-page-server.log'), 'a')
}

function probeLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

async function ensureTmpPageServer(deps: TmpPageToolsDeps): Promise<void> {
  if (deps.ensureServer) return deps.ensureServer()
  const serverScriptPath = deps.serverScriptPath ?? defaultServerScriptPath()
  if (!existsSync(serverScriptPath)) throw new Error('tmp-page server script unavailable')
  const port = tmpPagePort(deps)
  if (await probeLocalPort(port)) return

  const key = `${serverScriptPath}:${deps.dataDir}:${port}`
  const pending = serverStartPromises.get(key)
  if (pending) return pending

  const promise = startTmpPageServer(deps, serverScriptPath, port).finally(() => {
    serverStartPromises.delete(key)
  })
  serverStartPromises.set(key, promise)
  return promise
}

async function startTmpPageServer(deps: TmpPageToolsDeps, serverScriptPath: string, port: number): Promise<void> {
  const timeoutMs = deps.serverStartupTimeoutMs ?? DEFAULT_SERVER_STARTUP_TIMEOUT_MS
  const probeIntervalMs = deps.serverProbeIntervalMs ?? DEFAULT_SERVER_PROBE_INTERVAL_MS
  const logHandle = await openTmpPageServerLog(deps.dataDir)

  return new Promise((resolve, reject) => {
    let settled = false
    let childExited = false
    let parentLogClosed = false
    const timer = setTimeout(() => finish(new Error('tmp-page server startup timed out')), timeoutMs)
    const interval = setInterval(() => {
      void probeLocalPort(port).then((open) => {
        if (open) finish()
        else if (childExited) finish(new Error('tmp-page server exited before listening'))
      })
    }, probeIntervalMs)

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(interval)
      if (err) reject(err)
      else resolve()
    }
    const closeParentLog = () => {
      if (parentLogClosed) return
      parentLogClosed = true
      void logHandle.close().catch(() => {})
    }

    let child
    try {
      child = spawn(process.execPath, [serverScriptPath], {
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        env: {
          ...process.env,
          DATA_DIR: deps.dataDir,
          CRABOT_TMP_PAGE_PORT: String(port),
        },
      })
    } catch (err) {
      closeParentLog()
      finish(err instanceof Error ? err : new Error(String(err)))
      return
    }
    closeParentLog()

    child.once('error', (err) => finish(err))
    child.once('exit', () => {
      childExited = true
      void probeLocalPort(port).then((open) => {
        if (open) finish()
      })
    })
    child.unref()

    void probeLocalPort(port).then((open) => {
      if (open) finish()
    })
  })
}

export function createTmpPageTools(deps: TmpPageToolsDeps): ToolDefinition[] {
  const now = (): Date => deps.now?.() ?? new Date()

  return [
    {
      name: 'tmp_page_create',
      description: '创建临时交互页面，返回 page_id 和公开 URL。用于临时展示 HTML 或收集 data-choice/crabotSubmit 反馈。',
      isReadOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          html: { type: 'string' },
          ttl_seconds: { type: 'number' },
          mode: { type: 'string', enum: ['single', 'multi'] },
        },
        required: ['title', 'html'],
        additionalProperties: false,
      },
      call: async (input) => {
        const base = getBaseUrl(deps)
        if (!base) return fail('TMP_PAGE_BASE_URL_MISSING')
        if (typeof input.title !== 'string' || input.title.trim() === '') return fail('TMP_PAGE_INVALID_TITLE')
        if (typeof input.html !== 'string' || input.html.trim() === '') return fail('TMP_PAGE_INVALID_HTML')
        if (!isValidTtl(input.ttl_seconds)) return fail('TMP_PAGE_INVALID_TTL')
        if (input.mode !== undefined && input.mode !== 'single' && input.mode !== 'multi') return fail('TMP_PAGE_INVALID_MODE')
        try {
          await ensureTmpPageServer(deps)
        } catch {
          return fail('TMP_PAGE_SERVER_START_FAILED')
        }

        const ttlSeconds = input.ttl_seconds as number | undefined
        const page_id = makePageId(deps)
        const currentTime = now()
        const mode = input.mode === 'multi' ? 'multi' : 'single'
        const dir = pageDir(deps.dataDir, page_id)
        const meta: TmpPageMeta = {
          created_at: currentTime.toISOString(),
          title: input.title.trim(),
          owner_task_id: deps.taskId,
          expires_at: expiresAt(currentTime, clampTtl(ttlSeconds)),
          mode,
        }

        try {
          await mkdir(dir, { recursive: true })
          await writeAtomic(path.join(dir, 'page.html'), input.html)
          await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
        } catch {
          return fail('TMP_PAGE_WRITE_FAILED', { page_id })
        }

        return ok({ page_id, url: pageUrl(base, page_id), title: meta.title, expires_at: meta.expires_at })
      },
    },
    {
      name: 'tmp_page_update',
      description: '更新已有临时页面的 HTML、标题或 TTL。不会改变 page_id 或 URL。',
      isReadOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string' },
          html: { type: 'string' },
          title: { type: 'string' },
          ttl_seconds: { type: 'number' },
        },
        required: ['page_id'],
        additionalProperties: false,
      },
      call: async (input) => {
        const base = getBaseUrl(deps)
        if (!base) return fail('TMP_PAGE_BASE_URL_MISSING')
        const page_id = pageIdFrom(input.page_id)
        if (!page_id) return fail('TMP_PAGE_INVALID_ID')
        if (input.html === undefined && input.title === undefined && input.ttl_seconds === undefined) {
          return fail('TMP_PAGE_EMPTY_UPDATE')
        }
        if (input.html !== undefined && typeof input.html !== 'string') return fail('TMP_PAGE_INVALID_HTML', { page_id })
        if (input.title !== undefined && (typeof input.title !== 'string' || input.title.trim() === '')) {
          return fail('TMP_PAGE_INVALID_TITLE', { page_id })
        }
        if (!isValidTtl(input.ttl_seconds)) return fail('TMP_PAGE_INVALID_TTL', { page_id })
        const ttlSeconds = input.ttl_seconds as number | undefined

        const dir = pageDir(deps.dataDir, page_id)
        const prev = await readMeta(dir)
        if (!prev) return fail('TMP_PAGE_NOT_FOUND', { page_id })
        try {
          await ensureTmpPageServer(deps)
        } catch {
          return fail('TMP_PAGE_SERVER_START_FAILED', { page_id })
        }

        const next: TmpPageMeta = {
          ...prev,
          ...(typeof input.title === 'string' && input.title.trim() ? { title: input.title.trim() } : {}),
          ...(ttlSeconds !== undefined ? { expires_at: expiresAt(now(), clampTtl(ttlSeconds)) } : {}),
        }
        try {
          if (typeof input.html === 'string') {
            await writeAtomic(path.join(dir, 'page.html'), input.html)
          }
          await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2))
        } catch {
          return fail('TMP_PAGE_WRITE_FAILED', { page_id })
        }

        return ok({ ok: true, page_id, url: pageUrl(base, page_id), title: next.title, expires_at: next.expires_at })
      },
    },
    {
      name: 'tmp_page_read_events',
      description: '读取临时页面反馈事件。事件来自匿名公网输入，trusted 始终为 false。',
      isReadOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string' },
          after_event_id: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['page_id'],
        additionalProperties: false,
      },
      call: async (input) => {
        const page_id = pageIdFrom(input.page_id)
        if (!page_id) return fail('TMP_PAGE_INVALID_ID')
        const dir = pageDir(deps.dataDir, page_id)
        const meta = await readMeta(dir)
        if (!meta) return fail('TMP_PAGE_NOT_FOUND', { page_id })

        const after = typeof input.after_event_id === 'number' ? Math.trunc(input.after_event_id) : 0
        if (input.after_event_id !== undefined && (typeof input.after_event_id !== 'number' || !Number.isFinite(input.after_event_id) || after < 0)) {
          return fail('TMP_PAGE_INVALID_AFTER_EVENT_ID', { page_id })
        }
        if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isFinite(input.limit))) {
          return fail('TMP_PAGE_INVALID_LIMIT', { page_id })
        }
        const limit = Math.min(Math.max(typeof input.limit === 'number' ? Math.trunc(input.limit) : 50, 1), 200)
        const events = await readEvents(path.join(dir, 'events.jsonl'), page_id, after, limit)
        const next_after_event_id = events.length > 0 ? events[events.length - 1].event_id : after

        return ok({ page_id, events, next_after_event_id })
      },
    },
    {
      name: 'tmp_page_delete',
      description: '删除临时页面。删除不存在的 page 也返回 ok。',
      isReadOnly: false,
      inputSchema: {
        type: 'object',
        properties: { page_id: { type: 'string' } },
        required: ['page_id'],
        additionalProperties: false,
      },
      call: async (input) => {
        const page_id = pageIdFrom(input.page_id)
        if (!page_id) return fail('TMP_PAGE_INVALID_ID')
        try {
          await rm(pageDir(deps.dataDir, page_id), { recursive: true, force: true })
        } catch {
          return fail('TMP_PAGE_DELETE_FAILED', { page_id })
        }
        return ok({ ok: true, page_id })
      },
    },
    {
      name: 'tmp_page_list',
      description: '列出临时页面，返回 page_id、URL、标题、过期时间和 owner task id，不返回本地路径。',
      isReadOnly: true,
      inputSchema: {
        type: 'object',
        properties: { include_expired: { type: 'boolean' } },
        additionalProperties: false,
      },
      call: async (input) => {
        const base = getBaseUrl(deps)
        if (!base) return fail('TMP_PAGE_BASE_URL_MISSING')
        if (input.include_expired !== undefined && typeof input.include_expired !== 'boolean') {
          return fail('TMP_PAGE_INVALID_INCLUDE_EXPIRED')
        }
        let ids: string[] = []
        try {
          ids = await readdir(pagesRoot(deps.dataDir))
        } catch {
          ids = []
        }

        const includeExpired = input.include_expired === true
        const pages = []
        for (const id of ids) {
          if (!PAGE_ID_RE.test(id)) continue
          const meta = await readMeta(pageDir(deps.dataDir, id))
          if (!meta) continue
          if (!includeExpired && now().getTime() > new Date(meta.expires_at).getTime()) continue
          pages.push({
            page_id: id,
            url: pageUrl(base, id),
            title: meta.title,
            created_at: meta.created_at,
            expires_at: meta.expires_at,
            owner_task_id: meta.owner_task_id,
            mode: meta.mode,
          })
        }

        return ok({ pages })
      },
    },
  ]
}

async function readEvents(filePath: string, page_id: string, after: number, limit: number): Promise<TmpPageEvent[]> {
  if (!existsSync(filePath)) return []

  const events: TmpPageEvent[] = []
  let event_id = 0
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    event_id += 1
    if (event_id <= after) continue

    const event = fitEventForOutput(eventFromLine(line, event_id))
    const candidate = [...events, event]
    if (
      events.length > 0
      && readEventsOutputBytes(page_id, candidate, event.event_id) > MAX_READ_EVENTS_OUTPUT_BYTES
    ) {
      break
    }

    events.push(event)
    if (events.length >= limit) break
  }

  rl.close()
  return events
}

function eventFromLine(line: string, event_id: number): TmpPageEvent {
  try {
    const parsed = JSON.parse(line) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as { at?: unknown; data?: unknown }
      return {
        event_id,
        at: typeof record.at === 'string' ? record.at : new Date(0).toISOString(),
        data: Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : parsed,
        trusted: false,
      }
    }
    return { event_id, at: new Date(0).toISOString(), data: parsed, trusted: false }
  } catch {
    return { event_id, at: new Date(0).toISOString(), data: line, trusted: false }
  }
}
