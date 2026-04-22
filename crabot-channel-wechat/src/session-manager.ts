/**
 * SessionManager - 简化版 Session 管理
 *
 * 将微信会话（私聊 wxid / 群聊 chatroom）映射为 Crabot Session。
 * Session 持久化到 data_dir/sessions.json。
 */

import fs from 'node:fs'
import path from 'node:path'
import { generateId, generateTimestamp } from 'crabot-shared'
import type { ModuleId, Session, SessionType, SessionParticipant, SessionPermissions } from './types.js'

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

  /**
   * 根据平台会话 ID 查找或创建 Session
   */
  upsert(params: {
    platform_session_id: string
    type: SessionType
    title: string
    sender_wxid: string
    sender_name: string
  }): { session: Session; created: boolean } {
    const existing = this.findByPlatformId(params.platform_session_id)

    if (existing) {
      // 更新参与者
      const updated = this.ensureParticipant(existing, params.sender_wxid, params.sender_name)
      if (updated) this.save()
      return { session: existing, created: false }
    }

    const session: Session = {
      id: generateId(),
      channel_id: this.channelId,
      type: params.type,
      platform_session_id: params.platform_session_id,
      title: params.title,
      participants: [
        {
          platform_user_id: params.sender_wxid,
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

  /**
   * 根据上游拉到的完整群成员快照幂等创建/更新 group session。
   * 与 upsert() 的区别：upsert 是"收到一条消息，只知道单个 sender"，
   * 本方法写入全量参与者列表，用于启动 bootstrap。
   */
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

    const session: Session = {
      id: generateId(),
      channel_id: this.channelId,
      type: 'group',
      platform_session_id: params.platform_session_id,
      title: params.title,
      participants: params.participants,
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

  private ensureParticipant(session: Session, wxid: string, name: string): boolean {
    const exists = session.participants.some((p) => p.platform_user_id === wxid)
    if (exists) return false

    // immutable update
    const updatedParticipants: SessionParticipant[] = [
      ...session.participants,
      { platform_user_id: wxid, role: 'member' },
    ]
    session.participants = updatedParticipants
    session.updated_at = generateTimestamp()
    return true
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      // 兼容两种格式：数组 [...] 或对象 { sessions: { id: session } }
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
