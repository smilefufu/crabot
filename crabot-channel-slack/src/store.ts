import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { RpcError } from 'crabot-shared'
import type { CacheConfig, HistoryMessage, PaginationParams, Session, SlackConversation } from './types.js'

export function paginate<T>(items: T[], pagination?: Partial<PaginationParams>, limit?: number) {
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RpcError('INVALID_ARGUMENT', 'limit 必须为正整数')
    const selected = items.slice(-limit)
    return { items: selected, pagination: { page: 1, page_size: limit, total_items: selected.length, total_pages: 1 } }
  }
  const page = pagination?.page ?? 1, size = pagination?.page_size ?? 20
  if (!Number.isSafeInteger(page) || page <= 0 || !Number.isSafeInteger(size) || size <= 0 || size > 100) throw new RpcError('INVALID_ARGUMENT', '分页参数无效')
  return { items: items.slice((page - 1) * size, page * size), pagination: { page, page_size: size, total_items: items.length, total_pages: Math.ceil(items.length / size) } }
}
function atomic(file: string, data: unknown) {
  const temp = file + '.tmp'
  try { fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(temp, file) }
  finally { fs.rmSync(temp, { force: true }) }
}
export class Store {
  sessions: Map<string, Session>
  private readonly file: string
  constructor(private readonly dir: string, private readonly moduleId: string) {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true })
    this.file = path.join(dir, 'sessions.json')
    this.sessions = new Map((fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) as Session[] : []).map(s => [s.id, s]))
  }
  session(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new RpcError('NOT_FOUND', 'Session 不存在')
    return s
  }
  upsert(c: SlackConversation, title: string, sender?: string) {
    if (!c.id) throw new RpcError('CHANNEL_PLATFORM_USER_QUERY_UNAVAILABLE', 'Slack 未返回会话 ID')
    const id = createHash('sha256').update(`${this.moduleId}\0${c.id}`).digest('hex').slice(0, 24)
    const old = this.sessions.get(id), now = new Date().toISOString()
    const participants = [...(old?.participants ?? [])]
    if (sender && !participants.some(p => p.platform_user_id === sender)) participants.push({ friend_id: '', platform_user_id: sender, role: 'member' })
    const session: Session = old ? { ...old, title, participants, updated_at: now } : {
      id, channel_id: this.moduleId, platform_session_id: c.id, type: c.is_im ? 'private' : 'group', title, participants,
      permissions: { tool_access: { memory: false, messaging: false, task: false, mcp_skill: false, file_io: false, browser: false, shell: false, remote_exec: false, desktop: false }, storage: null },
      memory_scopes: [id], workspace_path: '', created_at: now, updated_at: now,
    }
    const next = new Map(this.sessions).set(id, session)
    atomic(this.file, [...next.values()])
    this.sessions = next
    return { session, created: !old }
  }
  remove(id: string) {
    const old = this.sessions.get(id)
    if (!old) return undefined
    const next = new Map(this.sessions); next.delete(id)
    atomic(this.file, [...next.values()])
    this.sessions = next
    fs.rmSync(this.messageFile(id), { force: true })
    fs.rmSync(this.messageFile(id) + '.boundary', { force: true })
    return old
  }
  private messageFile(id: string) { return path.join(this.dir, 'messages', createHash('sha256').update(id).digest('hex') + '.jsonl') }
  messages(id: string, cache: CacheConfig): HistoryMessage[] {
    const file = this.messageFile(id)
    const all: HistoryMessage[] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const cutoff = Date.now() - cache.max_days * 86400000
    const kept = all.filter(m => Date.parse(m.platform_timestamp) >= cutoff).slice(-cache.max_messages_per_session)
    if (kept.length !== all.length) {
      const removed = all.filter(m => !kept.includes(m))
      const previous = fs.existsSync(file + '.boundary') ? Number(fs.readFileSync(file + '.boundary', 'utf8')) : 0
      atomic(file + '.boundary', Math.max(previous, ...removed.map(m => Date.parse(m.platform_timestamp))))
      this.writeMessages(file, kept)
    }
    return kept
  }
  append(id: string, message: HistoryMessage, cache: CacheConfig) {
    const rows = this.messages(id, cache)
    if (!rows.some(m => m.platform_message_id === message.platform_message_id)) {
      rows.push(message)
      // Rewriting the bounded JSONL atomically avoids a torn final record on restart.
      this.writeMessages(this.messageFile(id), rows)
      this.messages(id, cache)
    }
  }
  private writeMessages(file: string, rows: HistoryMessage[]) {
    const temp = file + '.tmp'
    try { fs.writeFileSync(temp, rows.map(m => JSON.stringify(m)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 }); fs.renameSync(temp, file) }
    finally { fs.rmSync(temp, { force: true }) }
  }
  history(id: string, cache: CacheConfig, range?: { start?: string; end?: string }, keyword?: string) {
    this.session(id)
    const rows = this.messages(id, cache)
    const start = range?.start === undefined ? undefined : Date.parse(range.start)
    const end = range?.end === undefined ? undefined : Date.parse(range.end)
    if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end)) || (start !== undefined && end !== undefined && start >= end)) throw new RpcError('INVALID_ARGUMENT', '时间范围无效')
    const boundary = this.messageFile(id) + '.boundary'
    const removedThrough = fs.existsSync(boundary) ? Number(fs.readFileSync(boundary, 'utf8')) : 0
    const cutoff = Date.now() - cache.max_days * 86400000
    const crossesAgeBoundary = (start !== undefined && start < cutoff) || (end !== undefined && end <= cutoff)
    const crossesRemovedMessages = removedThrough && (
      (start !== undefined && start <= removedThrough) || (end !== undefined && end <= removedThrough)
    )
    if (crossesAgeBoundary || crossesRemovedMessages) {
      throw new RpcError('CHANNEL_HISTORY_UNAVAILABLE', '查询范围超出本地交互缓存；这不是完整 Slack 历史')
    }
    return rows.filter(m => (start === undefined || Date.parse(m.platform_timestamp) >= start) && (end === undefined || Date.parse(m.platform_timestamp) < end) && (!keyword || m.content.text?.toLowerCase().includes(keyword.toLowerCase())))
  }
}
