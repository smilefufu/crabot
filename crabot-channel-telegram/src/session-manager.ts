/**
 * SessionManager - Session 管理
 *
 * 将 Telegram chat（私聊 user_id / 群聊 group_id）映射为 Crabot Session。
 * Session 持久化到 data_dir/sessions.json。
 */

import fs from 'node:fs'
import path from 'node:path'
import { generateId, generateTimestamp } from 'crabot-shared'
import type { ModuleId, Session, SessionType, SessionPermissions } from './types.js'

const DEFAULT_PERMISSIONS: SessionPermissions = {
  desktop: false,
  network: { mode: 'allow_all', rules: [] },
  storage: [],
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

  upsert(params: {
    platform_session_id: string
    type: SessionType
    title: string
    sender_user_id: string
    sender_name: string
  }): { session: Session; created: boolean } {
    const existing = this.findByPlatformId(params.platform_session_id)

    if (existing) {
      const updated = this.ensureParticipant(existing, params.sender_user_id)
      if (updated) this.save()
      const current = this.sessions.get(existing.id) ?? existing
      return { session: current, created: false }
    }

    const session: Session = {
      id: generateId(),
      channel_id: this.channelId,
      type: params.type,
      platform_session_id: params.platform_session_id,
      title: params.title,
      participants: [
        {
          platform_user_id: params.sender_user_id,
          role: 'member',
        },
      ],
      permissions: DEFAULT_PERMISSIONS,
      memory_scopes: [params.platform_session_id],
      workspace_path: '',
      created_at: generateTimestamp(),
      updated_at: generateTimestamp(),
    }

    this.sessions.set(session.id, session)
    this.platformToId.set(params.platform_session_id, session.id)
    this.save()

    return { session, created: true }
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

  private ensureParticipant(session: Session, userId: string): boolean {
    const exists = session.participants.some((p) => p.platform_user_id === userId)
    if (exists) return false

    const updated: Session = {
      ...session,
      participants: [
        ...session.participants,
        { platform_user_id: userId, role: 'member' },
      ],
      updated_at: generateTimestamp(),
    }
    this.sessions.set(updated.id, updated)
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
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const data = Array.from(this.sessions.values())
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      console.error('[SessionManager] Failed to save sessions:', error)
    }
  }
}
