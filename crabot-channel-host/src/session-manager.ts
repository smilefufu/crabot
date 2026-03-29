/**
 * SessionManager - Channel Host Session 管理
 *
 * 管理私聊会话，支持持久化存储
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Session,
  SessionType,
  SessionId,
  SessionParticipant,
  SessionPermissions,
  ModuleId,
} from './types.js'

// ============================================================================
// 类型定义
// ============================================================================

interface SessionStore {
  sessions: Record<string, Session>
  platformIndex: Record<string, SessionId>
}

// ============================================================================
// SessionManager
// ============================================================================

export class SessionManager {
  private sessions: Map<SessionId, Session> = new Map()
  /** 平台会话 ID → Session ID 的快速索引 */
  private platformIndex: Map<string, SessionId> = new Map()
  private readonly channelId: ModuleId
  private readonly dataPath: string
  private readonly workspacePath: string

  constructor(channelId: ModuleId, dataDir: string) {
    this.channelId = channelId
    this.dataPath = path.join(dataDir, 'sessions.json')
    this.workspacePath = path.join(dataDir, 'workspaces')
    this.loadFromDisk()
  }

  /**
   * 根据平台会话 ID 查找 Session
   */
  findByPlatformId(platformSessionId: string): Session | null {
    const sessionId = this.platformIndex.get(platformSessionId)
    if (!sessionId) return null
    return this.sessions.get(sessionId) ?? null
  }

  /**
   * 根据 Session ID 查找 Session
   */
  findById(sessionId: SessionId): Session | null {
    return this.sessions.get(sessionId) ?? null
  }

  /**
   * 创建或更新私聊 Session
   */
  upsertPrivateSession(params: {
    platform_session_id: string
    participant_platform_user_id: string
    participant_friend_id?: string
    participant_display_name: string
  }): { session: Session; created: boolean } {
    const existing = this.findByPlatformId(params.platform_session_id)
    if (existing) {
      return { session: existing, created: false }
    }

    const sessionId = randomUUID()
    const now = new Date().toISOString()
    const workspacePath = path.join(this.workspacePath, sessionId)

    const participants: SessionParticipant[] = [
      {
        friend_id: params.participant_friend_id,
        platform_user_id: params.participant_platform_user_id,
        role: 'owner',
      },
    ]

    const session: Session = {
      id: sessionId,
      channel_id: this.channelId,
      type: 'private',
      platform_session_id: params.platform_session_id,
      title: params.participant_display_name,
      participants,
      permissions: this.buildDefaultPermissions('private'),
      memory_scopes: [sessionId],
      workspace_path: workspacePath,
      created_at: now,
      updated_at: now,
    }

    this.sessions.set(sessionId, session)
    this.platformIndex.set(params.platform_session_id, sessionId)
    this.saveToDisk()

    return { session, created: true }
  }

  /**
   * 创建或更新群聊 Session
   */
  upsertGroupSession(params: {
    platform_session_id: string
    participant_platform_user_id: string
    participant_friend_id?: string
    participant_display_name: string
  }): { session: Session; created: boolean } {
    const existing = this.findByPlatformId(params.platform_session_id)
    if (existing) {
      return { session: existing, created: false }
    }

    const sessionId = randomUUID()
    const now = new Date().toISOString()
    const workspacePath = path.join(this.workspacePath, sessionId)

    const participants: SessionParticipant[] = [
      {
        friend_id: params.participant_friend_id,
        platform_user_id: params.participant_platform_user_id,
        role: 'owner',
      },
    ]

    const session: Session = {
      id: sessionId,
      channel_id: this.channelId,
      type: 'group',
      platform_session_id: params.platform_session_id,
      title: params.participant_display_name,
      participants,
      permissions: this.buildDefaultPermissions('group'),
      memory_scopes: [sessionId],
      workspace_path: workspacePath,
      created_at: now,
      updated_at: now,
    }

    this.sessions.set(sessionId, session)
    this.platformIndex.set(params.platform_session_id, sessionId)
    this.saveToDisk()

    return { session, created: true }
  }

  /**
   * 列出所有 Session
   */
  listSessions(type?: SessionType): Session[] {
    const all = Array.from(this.sessions.values())
    if (!type) return all
    return all.filter((s) => s.type === type)
  }

  // ============================================================================
  // 内部方法
  // ============================================================================

  private buildDefaultPermissions(type: SessionType): SessionPermissions {
    return {
      desktop: false,
      network: {
        mode: type === 'private' ? 'allow_all' : 'blacklist',
        rules: [],
      },
      storage: [],
    }
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.dataPath)) return

    try {
      const raw = fs.readFileSync(this.dataPath, 'utf-8')
      const parsed = JSON.parse(raw) as SessionStore | Session[]

      // 兼容旧格式：数组形式的 Session 列表
      if (Array.isArray(parsed)) {
        for (const session of parsed) {
          this.sessions.set(session.id, session)
          if (session.platform_session_id) {
            this.platformIndex.set(session.platform_session_id, session.id)
          }
        }
        // 迁移为新格式
        this.saveToDisk()
        return
      }

      for (const [id, session] of Object.entries(parsed.sessions ?? {})) {
        this.sessions.set(id, session)
      }
      for (const [platformId, sessionId] of Object.entries(parsed.platformIndex ?? {})) {
        this.platformIndex.set(platformId, sessionId)
      }
    } catch (error) {
      console.error('[SessionManager] Failed to load sessions from disk:', error)
    }
  }

  private saveToDisk(): void {
    const store: SessionStore = {
      sessions: Object.fromEntries(this.sessions.entries()),
      platformIndex: Object.fromEntries(this.platformIndex.entries()),
    }

    const dir = path.dirname(this.dataPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(store, null, 2), 'utf-8')
    } catch (error) {
      console.error('[SessionManager] Failed to save sessions to disk:', error)
    }
  }
}
