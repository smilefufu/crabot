/**
 * SessionManager - 飞书 Session 管理
 *
 * chat_id（群聊）/ open_id（私聊）→ Crabot Session 映射，持久化到 data_dir/sessions.json。
 * 与 wechat 模块结构一致，字段语义改为飞书的 open_id / chat_id。
 */

import fs from 'node:fs'
import path from 'node:path'
import { generateId, generateTimestamp } from 'crabot-shared'
import type {
  ModuleId,
  Session,
  SessionType,
  SessionParticipant,
  SessionPermissions,
} from './types.js'

const DEFAULT_PERMISSIONS: SessionPermissions = {
  desktop: false,
  network: { mode: 'allow_all', rules: [] },
  storage: [],
}

function isBetterTitle(incoming: string, current: string, platformSessionId: string): boolean {
  const next = incoming?.trim()
  if (!next || next === current) return false
  if (next === platformSessionId) return false
  return current === platformSessionId || current.trim().length === 0
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map()
  private platformToId: Map<string, string> = new Map()
  private readonly filePath: string
  private readonly channelId: ModuleId

  constructor(channelId: ModuleId, dataDir: string) {
    this.channelId = channelId
    this.filePath = path.join(dataDir, 'sessions.json')
    this.load()
  }

  /** 收到一条消息时使用：只知道单个 sender，按需创建/更新 session */
  upsert(params: {
    platform_session_id: string
    type: SessionType
    title: string
    sender_id: string
    sender_name: string
  }): { session: Session; created: boolean } {
    const existing = this.findByPlatformId(params.platform_session_id)

    if (existing) {
      let mutated = this.ensureParticipant(existing, params.sender_id)
      if (isBetterTitle(params.title, existing.title, params.platform_session_id)) {
        existing.title = params.title
        existing.updated_at = generateTimestamp()
        mutated = true
      }
      if (mutated) this.save()
      return { session: existing, created: false }
    }

    const session = this.createAndStoreSession({
      type: params.type,
      platform_session_id: params.platform_session_id,
      title: params.title,
      participants: [{ platform_user_id: params.sender_id, role: 'member' }],
    })
    return { session, created: true }
  }

  /** 群聊全量快照 upsert（启动时 bootstrap 用） */
  upsertGroupSessionFromSnapshot(params: {
    platform_session_id: string
    title: string
    participants: SessionParticipant[]
  }): { session: Session; created: boolean } {
    const existing = this.findByPlatformId(params.platform_session_id)
    if (existing) {
      const updated: Session = {
        ...existing,
        title: params.title,
        participants: params.participants,
        updated_at: generateTimestamp(),
      }
      this.sessions.set(updated.id, updated)
      this.save()
      return { session: updated, created: false }
    }

    const session = this.createAndStoreSession({
      type: 'group',
      platform_session_id: params.platform_session_id,
      title: params.title,
      participants: params.participants,
    })
    return { session, created: true }
  }

  /** 群成员加入 */
  applyParticipantsAdded(platformSessionId: string, added: SessionParticipant[]): Session | undefined {
    const existing = this.findByPlatformId(platformSessionId)
    if (!existing) return undefined
    const known = new Set(existing.participants.map((p) => p.platform_user_id))
    const filtered = added.filter((p) => !known.has(p.platform_user_id))
    if (filtered.length === 0) return existing
    const updated: Session = {
      ...existing,
      participants: [...existing.participants, ...filtered],
      updated_at: generateTimestamp(),
    }
    this.sessions.set(updated.id, updated)
    this.save()
    return updated
  }

  /** 群成员移除 */
  applyParticipantsRemoved(platformSessionId: string, removedIds: string[]): Session | undefined {
    const existing = this.findByPlatformId(platformSessionId)
    if (!existing) return undefined
    const removeSet = new Set(removedIds)
    const next = existing.participants.filter((p) => !removeSet.has(p.platform_user_id))
    if (next.length === existing.participants.length) return existing
    const updated: Session = {
      ...existing,
      participants: next,
      updated_at: generateTimestamp(),
    }
    this.sessions.set(updated.id, updated)
    this.save()
    return updated
  }

  /** 更新 chat 标题（im.chat.updated_v1） */
  applyChatUpdate(platformSessionId: string, patch: { title?: string }): Session | undefined {
    const existing = this.findByPlatformId(platformSessionId)
    if (!existing) return undefined
    let mutated = false
    const next: Session = { ...existing }
    if (patch.title && isBetterTitle(patch.title, existing.title, platformSessionId)) {
      next.title = patch.title
      mutated = true
    }
    if (!mutated) return existing
    next.updated_at = generateTimestamp()
    this.sessions.set(next.id, next)
    this.save()
    return next
  }

  /** 整体删除 session（bot 退群 / 用户删除实例时） */
  removeByPlatformId(platformSessionId: string): Session | undefined {
    const existing = this.findByPlatformId(platformSessionId)
    if (!existing) return undefined
    this.sessions.delete(existing.id)
    this.platformToId.delete(platformSessionId)
    this.save()
    return existing
  }

  removeById(sessionId: string): Session | undefined {
    const existing = this.sessions.get(sessionId)
    if (!existing) return undefined
    this.sessions.delete(existing.id)
    this.platformToId.delete(existing.platform_session_id)
    this.save()
    return existing
  }

  findById(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  findByPlatformId(platformSessionId: string): Session | undefined {
    const id = this.platformToId.get(platformSessionId)
    return id ? this.sessions.get(id) : undefined
  }

  listSessions(type?: SessionType): Session[] {
    const all = Array.from(this.sessions.values())
    return type ? all.filter((s) => s.type === type) : all
  }

  private createAndStoreSession(params: {
    type: SessionType
    platform_session_id: string
    title: string
    participants: SessionParticipant[]
  }): Session {
    const now = generateTimestamp()
    const session: Session = {
      id: generateId(),
      channel_id: this.channelId,
      type: params.type,
      platform_session_id: params.platform_session_id,
      title: params.title,
      participants: params.participants,
      permissions: DEFAULT_PERMISSIONS,
      memory_scopes: [params.platform_session_id],
      workspace_path: '',
      created_at: now,
      updated_at: now,
    }
    this.sessions.set(session.id, session)
    this.platformToId.set(params.platform_session_id, session.id)
    this.save()
    return session
  }

  private ensureParticipant(session: Session, openId: string): boolean {
    if (!openId) return false
    if (session.participants.some((p) => p.platform_user_id === openId)) return false
    session.participants = [
      ...session.participants,
      { platform_user_id: openId, role: 'member' },
    ]
    session.updated_at = generateTimestamp()
    return true
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      const sessions: Session[] = Array.isArray(raw)
        ? raw
        : raw.sessions
          ? Object.values(raw.sessions)
          : []
      for (const session of sessions) {
        this.sessions.set(session.id, session)
        this.platformToId.set(session.platform_session_id, session.id)
      }
    } catch (error) {
      console.warn('[SessionManager] Failed to load sessions:', error)
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const data = Array.from(this.sessions.values())
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      console.error('[SessionManager] Failed to save sessions:', error)
    }
  }
}
