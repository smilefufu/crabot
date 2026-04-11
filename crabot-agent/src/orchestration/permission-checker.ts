/**
 * Permission Checker - 权限决策树
 *
 * 私聊决策树：Master? → Friend? → 待授权
 * 群聊决策树：@bot? → Master在群? → 是Master? → 拒绝
 */

import type { ModuleId, FriendId, RpcClient } from 'crabot-shared'
import type { PermissionResult, Friend } from '../types.js'

interface CheckParams {
  channel_id: ModuleId
  session_id: string
  sender_id: string
  message: string
  is_group: boolean
  is_at_bot: boolean
}

export class PermissionChecker {
  private friendCache: Map<string, { friend: Friend | null; timestamp: number }> = new Map()
  private cacheTTL = 60000 // 1 minute cache

  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private getAdminPort: () => number | Promise<number>
  ) {}

  /**
   * 检查消息权限
   */
  async checkPermission(params: CheckParams): Promise<PermissionResult> {
    // 1. 解析 Friend
    const friend = await this.resolveFriend(params.channel_id, params.sender_id)

    // 2. 根据会话类型走不同决策树
    if (params.is_group) {
      return this.checkGroupPermission(friend, params)
    }
    return this.checkPrivatePermission(friend)
  }

  /**
   * 私聊决策树
   */
  private async checkPrivatePermission(friend: Friend | null): Promise<PermissionResult> {
    // Master → 允许
    if (friend?.permission === 'master') {
      return { allowed: true, friend }
    }

    // Friend → 允许（带权限配置）
    if (friend) {
      const sessionConfig = await this.getSessionPermissionConfig(friend)
      return { allowed: true, friend, session_config: sessionConfig }
    }

    // 非 Friend → 待授权
    return {
      allowed: false,
      reason: 'pending_authorization',
    }
  }

  /**
   * 群聊决策树
   */
  private checkGroupPermission(
    friend: Friend | null,
    params: CheckParams
  ): PermissionResult {
    // 没有 @bot → 忽略
    if (!params.is_at_bot) {
      return { allowed: false, reason: 'not_mentioned' }
    }

    // Master → 允许
    if (friend?.permission === 'master') {
      return { allowed: true, friend }
    }

    // Friend → 允许
    if (friend) {
      return { allowed: true, friend }
    }

    // 非 Friend → 拒绝
    return { allowed: false, reason: 'not_friend' }
  }

  /**
   * 解析 Friend
   */
  private async resolveFriend(
    channelId: ModuleId,
    platformUserId: string
  ): Promise<Friend | null> {
    // 构建缓存 key
    const cacheKey = `${channelId}:${platformUserId}`

    // 检查缓存
    const cached = this.friendCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.friend
    }

    try {
      const adminPort = await this.getAdminPort()
      const result = await this.rpcClient.call<
        { channel_id: ModuleId; platform_user_id: string },
        { friend: Friend | null }
      >(
        adminPort,
        'resolve_friend',
        { channel_id: channelId, platform_user_id: platformUserId },
        this.moduleId
      )

      // 缓存结果
      this.friendCache.set(cacheKey, { friend: result.friend, timestamp: Date.now() })

      return result.friend
    } catch {
      return null
    }
  }

  /**
   * 清除 Friend 缓存
   */
  clearFriendCache(friendId: FriendId): void {
    // 清除所有与该 Friend 相关的缓存条目
    for (const [key, cached] of this.friendCache.entries()) {
      if (cached.friend?.id === friendId) {
        this.friendCache.delete(key)
      }
    }
  }

  /**
   * 清除所有缓存
   */
  clearAllCaches(): void {
    this.friendCache.clear()
  }

  /**
   * 获取 Session 权限配置
   */
  private async getSessionPermissionConfig(
    friend: Friend
  ): Promise<PermissionResult['session_config']> {
    if (!friend.permission_template_id) {
      return undefined
    }

    try {
      const adminPort = await this.getAdminPort()
      const result = await this.rpcClient.call<
        { template_id: string },
        { config: PermissionResult['session_config'] }
      >(
        adminPort,
        'get_permission_template',
        { template_id: friend.permission_template_id },
        this.moduleId
      )
      return result.config
    } catch {
      return undefined
    }
  }
}
