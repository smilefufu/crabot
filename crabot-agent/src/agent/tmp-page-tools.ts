import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolCallResult, ToolDefinition } from '../engine/types.js'

export interface TmpPageToolsDeps {
  readonly dataDir: string
  readonly getTmpPageBaseUrl: () => string | undefined
  readonly taskId: string
  readonly now?: () => Date
  readonly randomBytes?: (size: number) => Buffer
}

interface TmpPageMeta {
  readonly created_at: string
  readonly title: string
  readonly owner_task_id: string
  readonly expires_at: string
  readonly mode: 'single' | 'multi'
}

const PAGE_ID_RE = /^[A-Za-z0-9_-]{16,}$/
const DEFAULT_TTL_SECONDS = 24 * 60 * 60
const MIN_TTL_SECONDS = 60
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60

function ok(data: unknown): ToolCallResult {
  return { isError: false, output: JSON.stringify(data) }
}

function fail(error_code: string, extra: Record<string, unknown> = {}): ToolCallResult {
  return { isError: true, output: JSON.stringify({ success: false, error_code, ...extra }) }
}

function clampTtl(input: unknown): number {
  if (input === undefined) return DEFAULT_TTL_SECONDS
  if (typeof input !== 'number' || !Number.isFinite(input)) return DEFAULT_TTL_SECONDS
  return Math.min(Math.max(Math.trunc(input), MIN_TTL_SECONDS), MAX_TTL_SECONDS)
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

        const page_id = makePageId(deps)
        const currentTime = now()
        const mode = input.mode === 'multi' ? 'multi' : 'single'
        const dir = pageDir(deps.dataDir, page_id)
        const meta: TmpPageMeta = {
          created_at: currentTime.toISOString(),
          title: input.title.trim(),
          owner_task_id: deps.taskId,
          expires_at: expiresAt(currentTime, clampTtl(input.ttl_seconds)),
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

        const dir = pageDir(deps.dataDir, page_id)
        const prev = await readMeta(dir)
        if (!prev) return fail('TMP_PAGE_NOT_FOUND', { page_id })

        const next: TmpPageMeta = {
          ...prev,
          ...(typeof input.title === 'string' && input.title.trim() ? { title: input.title.trim() } : {}),
          ...(input.ttl_seconds !== undefined ? { expires_at: expiresAt(now(), clampTtl(input.ttl_seconds)) } : {}),
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
        const limit = Math.min(Math.max(typeof input.limit === 'number' ? Math.trunc(input.limit) : 50, 1), 200)
        let raw = ''
        try {
          raw = await readFile(path.join(dir, 'events.jsonl'), 'utf8')
        } catch {
          raw = ''
        }

        const events = raw
          .split('\n')
          .filter(Boolean)
          .map((line, idx) => eventFromLine(line, idx + 1))
          .filter((event) => event.event_id > after)
          .slice(0, limit)
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

function eventFromLine(line: string, event_id: number): { event_id: number; at: string; data: unknown; trusted: false } {
  try {
    const parsed = JSON.parse(line) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as { at?: unknown; data?: unknown }
      return {
        event_id,
        at: typeof record.at === 'string' ? record.at : new Date(0).toISOString(),
        data: record.data ?? parsed,
        trusted: false,
      }
    }
    return { event_id, at: new Date(0).toISOString(), data: parsed, trusted: false }
  } catch {
    return { event_id, at: new Date(0).toISOString(), data: line, trusted: false }
  }
}
