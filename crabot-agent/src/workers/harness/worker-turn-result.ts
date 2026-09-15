import { createHash } from 'crypto'
import type { NormalizedTraceEvent } from '../types.js'
import type { WorkerTurn, StoredWorkerTurn } from './worker-turn-store.js'

export interface WorkerCompletionResult {
  source: 'completion_summary' | 'assistant_text' | 'preview' | 'unavailable'
  content: string
  unavailable_reason?: string
}

/** 只从冻结回合的实际证据取正文；持久化预览不能冒充原文。 */
export function extractWorkerCompletion(
  events: ReadonlyArray<NormalizedTraceEvent>,
  summary?: string,
  unavailableReason?: string,
): WorkerCompletionResult {
  if (summary !== undefined) return { source: 'completion_summary', content: summary }
  const assistant = events.filter((event) => event.source !== 'harness' && event.kind === 'message' && event.role === 'assistant').at(-1)
  if (assistant) {
    const detail = assistant.detail as { content?: unknown; text?: unknown } | undefined
    const content = detail?.content
    let text: string | undefined
    if (typeof content === 'string') text = content
    else if (typeof detail?.text === 'string') text = detail.text
    else if (Array.isArray(content)) {
      text = content.flatMap((block) =>
        block && ['text', 'output_text'].includes(block.type) && typeof block.text === 'string' ? [block.text] : [],
      ).join('')
    }
    if (text !== undefined) return { source: 'assistant_text', content: text }
    return { source: 'preview', content: assistant.summary, unavailable_reason: unavailableReason ?? 'full assistant text is unavailable; only a persisted preview remains' }
  }
  return { source: 'unavailable', content: '', unavailable_reason: unavailableReason ?? 'turn completion text is unavailable' }
}

export interface GetWorkerTurnParams {
  worker_id: string
  turn_id?: string
  view?: 'result' | 'activity'
  cursor?: string
}

export interface GetWorkerTurnResult {
  worker_id: string
  turn: WorkerTurn | null
  view: 'result' | 'activity'
  content_source: WorkerCompletionResult['source'] | 'activity'
  content: string
  next_cursor: string | null
  unavailable_reason?: string
}

interface TurnCursor {
  version: 1
  worker_id: string
  turn_id: string
  view: 'result' | 'activity'
  source: string
  offset: number
}

export function readTurnCursor(params: GetWorkerTurnParams): TurnCursor | undefined {
  if (params.cursor === undefined) return undefined
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(params.cursor) || params.cursor.length > 4096) throw new Error()
    const value = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as TurnCursor
    if (value.version !== 1 || value.worker_id !== params.worker_id || typeof value.turn_id !== 'string' ||
        (params.turn_id !== undefined && params.turn_id !== value.turn_id) || value.view !== (params.view ?? 'result') ||
        typeof value.source !== 'string' || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error()
    return value
  } catch {
    throw new Error('get_worker_turn: invalid cursor or worker/turn/view mismatch')
  }
}

const MAX_PAGE_BYTES = 64 * 1024

/** 预算包含外层 JSON 转义和元数据，长 JSONL 行也允许跨页；拼接 content 即原文。 */
export function pageWorkerTurn(
  params: GetWorkerTurnParams,
  turn: StoredWorkerTurn | undefined,
  body: WorkerCompletionResult | { source: 'activity'; content: string; unavailable_reason?: string },
): GetWorkerTurnResult {
  const cursor = readTurnCursor(params)
  const source = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  const start = cursor?.offset ?? 0
  if (cursor && (!turn || cursor.turn_id !== turn.turn_id || cursor.source !== source || start > body.content.length ||
      (start > 0 && isLowSurrogate(body.content.charCodeAt(start))))) {
    throw new Error('get_worker_turn: cursor source changed or position is invalid')
  }
  const { completion_result: _internal, ...metadata } = turn ?? {} as StoredWorkerTurn
  const result: GetWorkerTurnResult = {
    worker_id: params.worker_id, turn: turn ? structuredClone(metadata) as WorkerTurn : null,
    view: params.view ?? 'result', content_source: body.source, content: '', next_cursor: null,
    ...(body.unavailable_reason ? { unavailable_reason: body.unavailable_reason } : {}),
  }
  // 只缩减本页的 Git 列表，保留已有数量和 truncated 语义，不改持久记录。
  const git = result.turn?.workspace_git
  if (git && Buffer.byteLength(JSON.stringify(result)) > MAX_PAGE_BYTES / 2) {
    for (const observation of [git.current, git.baseline]) {
      if (observation?.state.status === 'repository' && observation.state.changes.length) {
        observation.state.changes = []
        observation.state.changes_truncated = true
      }
    }
    if (git.commits.length) { git.commits = []; git.commits_truncated = true }
  }
  const render = (end: number) => ({
    ...result, content: body.content.slice(start, end),
    next_cursor: end < body.content.length && turn ? Buffer.from(JSON.stringify({
      version: 1, worker_id: params.worker_id, turn_id: turn.turn_id, view: result.view, source, offset: end,
    } satisfies TurnCursor)).toString('base64url') : null,
  })
  // 每个 UTF-16 字元序列化至少占一个字节，搜索范围无需超过单页大小。
  let low = start
  let high = Math.min(body.content.length, start + MAX_PAGE_BYTES)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(render(mid))) <= MAX_PAGE_BYTES) low = mid
    else high = mid - 1
  }
  if (low < body.content.length && isLowSurrogate(body.content.charCodeAt(low))) low--
  const page = render(low)
  if ((low === start && start < body.content.length) || Buffer.byteLength(JSON.stringify(page)) > MAX_PAGE_BYTES) {
    throw new Error('get_worker_turn: turn metadata exceeds page budget')
  }
  return page
}

function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff }
