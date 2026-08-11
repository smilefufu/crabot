/**
 * 人类消息发起人身份 —— 解析、按 key 缓存,以及由它派生的四样东西
 * (protocol-agent-v3.md §4.3 对话对象档案与记忆档位、§8.2 权限身份)。
 *
 * ## 为什么需要单独一层
 *
 * `ManagerRegistryDeps` 的 `toolFace` / `promptInputs` 全是**同步**
 * 签名——它们被 `ManagerLoop` 每轮 turn 同步调用(`EngineOptions.systemPrompt` 的 Resolvable
 * 必须同步)。而这几样东西的原料都是异步 RPC:admin 的 `resolve_principal_permissions`、
 * admin 的 `get_session_config`、memory 的 `get_scene_profile`。
 *
 * 解法**不是**把那些签名改成异步,而是"在唤醒边界解析一次、按 `ManagerKey` 缓存,同步
 * thunk 只读缓存"。这条路成立的前提是:**入站链路本来就知道"谁在说话"**——
 * `channel.message_authorized` 的 payload 自带完整 `friend` 对象,而入站点本来就在 async
 * 上下文里。缺的从来不是"能不能拿到 friend",只是"没有把它往下传"。
 *
 * ## 两个消费者
 *
 * 1. **记忆档位**(`ResolvedPrincipal.memory`):决定 manager 与它派出的 worker 写记忆时
 *    的 visibility / scopes。放着不管的现状是 `{visibility:'public', scopes:[]}`
 *    ——群 A 的对话会以 public 落记忆、群 B 读得到,是跨会话信息泄漏。
 * 2. **权限档位**(`ResolvedPrincipal.permissions`):manager 算好、随 spawn 下传给 worker
 *    (§8.2)。**worker 不需要知道 friend 是谁**,它只拿到一份算好的 `ResolvedPermissions`。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §3、§4.3、§4.4、§8.2
 */

import type { Friend, MemoryPermissions, ResolvedPermissions, RuntimeSceneProfile } from '../types.js'
import type { ManagerKey } from './types.js'
import { PrincipalBindingStore } from './principal-binding-store.js'
import type { LegacyContinuationAuth } from '../workers/harness/legacy-continuation-auth.js'

export interface LegacyContinuationAuthTemplate {
  readonly source_manager_key: ManagerKey
  readonly principal_kind: LegacyContinuationAuth['principal_kind']
  readonly principal_generation: number
  readonly principal_permissions: ResolvedPermissions
}

interface LegacyAuthorizationSource {
  readonly source_manager_key: ManagerKey
  readonly target_manager_key: ManagerKey
  readonly principal_kind: LegacyContinuationAuth['principal_kind']
  readonly principal_generation: number
}

export type MasterAuthorization =
  | { readonly kind: 'friend_master'; readonly manager_key: ManagerKey; readonly friend_id: string; readonly generation: number }
  | { readonly kind: 'admin_chat_jwt'; readonly manager_key: ManagerKey; readonly assertion_id: string; readonly expires_at: string; readonly generation: number }

/**
 * 一次人类消息唤醒随行的发起人身份。
 *
 * - `friend`:本批消息的**发言者**(私聊即对端;群聊取批内最后一条的发言者,与 v2
 *   `processGroupLaneBatch` 的 `lastEntry.friend` 逐字同义)。陌生人可为 undefined。
 * - `sessionType`:私聊 / 群聊。不新增数据来源——它就在 `ChannelMessage.session.type` 里。
 */
export interface HumanPrincipal {
  readonly friend?: Friend
  readonly sessionType: 'private' | 'group'
}

/** 按发起人身份解析出来的、本会话 manager 与它派出的 worker 共用的档位。 */
export interface ResolvedPrincipal {
  readonly principal: HumanPrincipal
  /** admin `resolve_principal_permissions` 的结果;解析失败为 null(fail-soft,与 v2 一致)。 */
  readonly permissions: ResolvedPermissions | null
  /** 由 `memory_scopes` 派生的记忆读写档位。 */
  readonly memory: MemoryPermissions
  /** system prompt 的「对话对象档案」段;无素材时 undefined。 */
  readonly dialogProfile?: string
}

/**
 * `memory_scopes` → `MemoryPermissions`。
 * 与 `unified-agent.ts` 私聊 `:1008-1015` / 群聊 `:1223-1230` 的字面量逐字段相同
 * (两处本来就是同一份代码抄了两遍)。
 */
export function memoryPermissionsFromScopes(scopes: ReadonlyArray<string>): MemoryPermissions {
  return {
    write_visibility: 'internal',
    write_scopes: [...scopes],
    read_min_visibility: 'internal',
    read_accessible_scopes: [...scopes],
  }
}

/**
 * 群聊防跨群泄漏:`memory_scopes` 为空时收敛到 `[sessionId]`(v2 `unified-agent.ts:1219-1221`)。
 *
 * **收敛落在 `ResolvedPermissions` 自身上,不只落在 memory 档位上** —— v2 就是这么做的,
 * 因为这份 `resolvedPerms` 还会随 spawn 下传给 worker,只修 memPerms 会让 worker 拿到
 * 空 scopes。私聊不做这个收敛(私聊没有跨群泄漏面,空 scopes 走 session 配置兜底)。
 */
export function applyGroupScopeFallback(
  permissions: ResolvedPermissions | null,
  sessionType: 'private' | 'group',
  sessionId: string,
): ResolvedPermissions | null {
  if (!permissions) return permissions
  if (sessionType !== 'group') return permissions
  if (permissions.memory_scopes.length > 0) return permissions
  return { ...permissions, memory_scopes: [sessionId] }
}

/**
 * 「对话对象档案」段的渲染:场景画像 + crab 在该渠道的 @handle。
 *
 * - 场景画像沿用 `prompts/assemble-agent.ts` 的 `<scene_profile label=...>` 包裹与同款
 *   闭合标签转义,不另发明一种格式;
 * - `crab_self_handle` 的措辞与 `agent-handler.ts:2549` 保持一致:多 bot 群里,这是
 *   crab 判断"哪个 @ 是发给我的"的唯一依据。
 *
 * 两样都没有时返回 undefined —— `assembleManagerSystemPrompt` 会整段跳过。
 */
export function renderDialogProfile(inputs: {
  readonly sceneProfile?: RuntimeSceneProfile | null
  readonly crabSelfHandle?: string
}): string | undefined {
  const parts: string[] = []
  if (inputs.sceneProfile) {
    const escaped = inputs.sceneProfile.content.replace(/<\/scene_profile>/g, '&lt;/scene_profile&gt;')
    parts.push(`<scene_profile label="${inputs.sceneProfile.label}">\n${escaped}\n</scene_profile>`)
  }
  if (inputs.crabSelfHandle) {
    parts.push(
      `你在该渠道的 @handle: ${inputs.crabSelfHandle}` +
        `(消息正文里出现这个字符串才是 @ 你;其它 @xxx 是发给别人的)`,
    )
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/** `ManagerKey` → `{channelId, sessionId}`。按**第一个** `::` 切(session_id 里可再含 `::`)。 */
export function splitManagerKey(key: ManagerKey): { channelId: string; sessionId: string } {
  const sep = key.indexOf('::')
  return sep < 0
    ? { channelId: key, sessionId: '' }
    : { channelId: key.slice(0, sep), sessionId: key.slice(sep + 2) }
}

/** 解析原料:全部是既有 RPC 的注入口,本模块不自己持有 rpcClient。 */
export interface PrincipalResolverDeps {
  /**
   * admin `resolve_principal_permissions`;失败返回 null(调用方 fail-soft)。
   *
   * 收 friend **id** 而不是 Friend 对象:admin 那侧本来就只用 `sender_friend_id`,而
   * scheduled 路径(§4.4 按 `Schedule.creator_friend_id` 解析)手上只有一个 id,没有 Friend
   * 对象——收对象会逼出一个"为了调用而伪造 Friend"的假身份。
   */
  readonly resolvePermissions: (p: {
    senderFriendId?: string
    sessionId: string
    sessionType: 'private' | 'group'
  }) => Promise<ResolvedPermissions | null>
  /** admin `get_session_config.memory_scopes`,兜底 `[sessionId]`(v2 `buildSessionMemoryPermissions` 同源)。 */
  readonly sessionMemoryScopes: (sessionId: string) => Promise<ReadonlyArray<string>>
  /** memory `get_scene_profile`;失败/不支持返回 null。 */
  readonly sceneProfile: (p: {
    channelId: string
    sessionId: string
    sessionType: 'private' | 'group'
    friendId?: string
  }) => Promise<RuntimeSceneProfile | null>
  /** crab 在该 channel 的 @handle(入站事件已缓存,同步读)。 */
  readonly crabSelfHandle: (channelId: string) => string | undefined
  /** Authoritative Admin record used for execution-time Master revalidation. */
  readonly getFriend?: (friendId: string) => Promise<Friend | null>
}

/**
 * 按 `ManagerKey` 缓存"最近一次人类消息解析出来的身份档位"。
 *
 * **写在唤醒边界(async),读在同步 thunk 里** —— 这就是本模块存在的全部理由。
 * 缓存是"最近一次",不是"永久快照":群聊里 A 说完 B 说,下一次唤醒会整体覆盖,
 * 与 v2「每批消息按发言者重新解析一次权限」的语义一致。
 */
export class ManagerPrincipalStore {
  private readonly resolved = new Map<ManagerKey, ResolvedPrincipal>()
  private readonly activeAuthorizations = new Map<ManagerKey, MasterAuthorization>()
  /** Exact minted credential object → source binding; object identity prevents credential collisions. */
  private readonly legacyAuthorizationSources = new WeakMap<LegacyContinuationAuth, LegacyAuthorizationSource>()

  constructor(
    private readonly deps: PrincipalResolverDeps,
    private readonly bindings?: PrincipalBindingStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async init(): Promise<void> {
    await this.bindings?.init()
  }

  /**
   * 唤醒边界解析:把 friend 变成权限 / 记忆档位 / 对话对象档案,写进缓存。
   *
   * **绝不抛错** —— 它挂在人类消息的必经之路上,解析失败绝不能连带把这条消息也弄丢。
   * 每一项都独立 fail-soft:权限解析失败 → `permissions: null` + 记忆档位走 session 配置
   * 兜底(与 v2 逐字同构);场景画像失败 → 该段不渲染。
   */
  async resolve(key: ManagerKey, principal: HumanPrincipal): Promise<ResolvedPrincipal> {
    const { channelId, sessionId } = splitManagerKey(key)

    let permissions: ResolvedPermissions | null = null
    let memory: MemoryPermissions
    try {
      permissions = applyGroupScopeFallback(
        await this.deps.resolvePermissions({
          ...(principal.friend ? { senderFriendId: principal.friend.id } : {}),
          sessionId,
          sessionType: principal.sessionType,
        }),
        principal.sessionType,
        sessionId,
      )
    } catch (err) {
      console.warn(`[manager-principal] 解析 '${key}' 的权限失败,按未解析处理:`, err)
    }

    if (permissions) {
      memory = memoryPermissionsFromScopes(permissions.memory_scopes)
    } else {
      // v2 `buildSessionMemoryPermissions`:退到 session 级 memory_scopes,再兜底 [sessionId]。
      let scopes: ReadonlyArray<string> = [sessionId]
      try {
        const fromSession = await this.deps.sessionMemoryScopes(sessionId)
        if (fromSession.length > 0) scopes = fromSession
      } catch (err) {
        console.warn(`[manager-principal] 解析 '${key}' 的 session memory_scopes 失败,兜底本会话:`, err)
      }
      memory = memoryPermissionsFromScopes(scopes)
    }

    let sceneProfile: RuntimeSceneProfile | null = null
    try {
      sceneProfile = await this.deps.sceneProfile({
        channelId,
        sessionId,
        sessionType: principal.sessionType,
        ...(principal.friend ? { friendId: principal.friend.id } : {}),
      })
    } catch (err) {
      console.warn(`[manager-principal] 解析 '${key}' 的场景画像失败,该段不渲染:`, err)
    }

    const dialogProfile = renderDialogProfile({
      sceneProfile,
      ...(this.deps.crabSelfHandle(channelId) ? { crabSelfHandle: this.deps.crabSelfHandle(channelId)! } : {}),
    })

    const entry: ResolvedPrincipal = {
      principal,
      permissions,
      memory,
      ...(dialogProfile ? { dialogProfile } : {}),
    }
    this.resolved.set(key, entry)
    // Admin Chat's synthetic Friend is never an identity authority. Its opaque assertion
    // is the only source that may create or replace this binding.
    if (key !== 'admin-web::admin-chat' && principal.sessionType === 'private' && principal.friend && this.bindings?.isInitialized()) {
      await this.bindings.set({ manager_key: key, kind: 'friend', friend_id: principal.friend.id })
      await this.refreshFriendAuthorization(key)
    }
    return entry
  }

  /** Only a verified current authorization can enter the tool face; bindings alone never grant Master after restart. */
  currentMasterAuthorization(key: ManagerKey): MasterAuthorization | undefined {
    const auth = this.activeAuthorizations.get(key)
    if (auth?.kind === 'admin_chat_jwt' && Date.parse(auth.expires_at) <= this.now().getTime()) {
      this.activeAuthorizations.delete(key)
      return undefined
    }
    return auth
  }

  async activateAdminChat(key: ManagerKey, input: { assertionId: string; expiresAt: string }): Promise<void> {
    if (!this.bindings) return
    if (!this.bindings.isInitialized()) await this.bindings.init()
    if (key !== 'admin-web::admin-chat' || Date.parse(input.expiresAt) <= this.now().getTime()) return
    const binding = await this.bindings.set({ manager_key: key, kind: 'admin_chat_jwt', assertion_id: input.assertionId, expires_at: input.expiresAt })
    this.activeAuthorizations.set(key, { kind: 'admin_chat_jwt', manager_key: key, assertion_id: input.assertionId, expires_at: input.expiresAt, generation: binding.generation })
  }

  async refreshForNonHumanWake(key: ManagerKey): Promise<void> {
    const binding = this.bindings?.get(key)
    if (binding?.kind !== 'friend' || !binding.friend_id) return
    try {
      const friend = await this.deps.getFriend?.(binding.friend_id)
      if (!friend) {
        await this.invalidatePrincipalBindingOnce(key, binding.generation)
        return
      }
      // Re-resolve current permissions before exposing a non-human tool face; do not
      // reuse a stale session cache after downgrade/regrant.
      await this.resolve(key, { friend, sessionType: 'private' })
    } catch {
      await this.invalidatePrincipalBindingOnce(key, binding.generation)
    }
  }

  async invalidateFriend(friendId: string): Promise<void> {
    if (!this.bindings?.isInitialized()) return
    await this.bindings.invalidateWhere(binding => binding.kind === 'friend' && binding.friend_id === friendId)
    for (const [key, auth] of this.activeAuthorizations) if (auth.kind === 'friend_master' && auth.friend_id === friendId) this.activeAuthorizations.delete(key)
    for (const [key, resolved] of this.resolved) if (resolved.principal.friend?.id === friendId) this.resolved.delete(key)
  }

  async validateMasterAuthorization(auth: MasterAuthorization): Promise<boolean> {
    const current = this.currentMasterAuthorization(auth.manager_key)
    if (!current || current.generation !== auth.generation || current.kind !== auth.kind) return false
    if (auth.kind === 'admin_chat_jwt') {
      return current.kind === 'admin_chat_jwt' && auth.assertion_id === current.assertion_id && Date.parse(auth.expires_at) > this.now().getTime()
    }
    const binding = this.bindings?.get(auth.manager_key)
    if (!binding || binding.kind !== 'friend' || binding.friend_id !== auth.friend_id || binding.generation !== auth.generation) return false
    try {
      const friend = await this.deps.getFriend?.(auth.friend_id)
      if (friend?.permission === 'master') return true
    } catch {
      // Lookup errors fail closed just like a missing/downgraded Friend.
    }
    await this.invalidateAuthorizationOnce(auth.manager_key, auth.generation)
    return false
  }

  /** Capture the current turn's credential source synchronously while the tool face is built. */
  captureLegacyContinuationAuth(key: ManagerKey): LegacyContinuationAuthTemplate | undefined {
    const resolved = this.resolved.get(key)
    const binding = this.bindings?.get(key)
    if (!resolved?.permissions || !binding) return undefined
    const active = this.currentMasterAuthorization(key)
    if (active?.kind === 'admin_chat_jwt' && active.generation === binding.generation) {
      return {
        source_manager_key: key,
        principal_kind: 'admin_chat_jwt',
        principal_generation: binding.generation,
        principal_permissions: resolved.permissions,
      }
    }
    if (
      resolved.principal.sessionType !== 'private' ||
      !resolved.principal.friend ||
      binding.kind !== 'friend' ||
      binding.friend_id !== resolved.principal.friend.id
    ) return undefined
    return {
      source_manager_key: key,
      principal_kind: 'friend',
      principal_generation: binding.generation,
      principal_permissions: resolved.permissions,
    }
  }

  bindLegacyContinuationAuth(
    template: LegacyContinuationAuthTemplate | undefined,
    targetManagerKey: ManagerKey,
  ): LegacyContinuationAuth | undefined {
    if (!template) return undefined
    const auth: LegacyContinuationAuth = {
      manager_key: targetManagerKey,
      principal_kind: template.principal_kind,
      principal_generation: template.principal_generation,
      principal_permissions: template.principal_permissions,
    }
    this.legacyAuthorizationSources.set(auth, {
      source_manager_key: template.source_manager_key,
      target_manager_key: targetManagerKey,
      principal_kind: template.principal_kind,
      principal_generation: template.principal_generation,
    })
    return auth
  }

  async validateLegacyContinuationAuth(auth: LegacyContinuationAuth): Promise<boolean> {
    const source = this.legacyAuthorizationSources.get(auth)
    if (
      !source ||
      source.target_manager_key !== auth.manager_key ||
      source.principal_kind !== auth.principal_kind ||
      source.principal_generation !== auth.principal_generation
    ) return false

    const sourceKey = source.source_manager_key
    const binding = this.bindings?.get(sourceKey)
    if (!binding || binding.generation !== auth.principal_generation) return false
    if (auth.principal_kind === 'admin_chat_jwt') {
      const active = this.currentMasterAuthorization(sourceKey)
      return binding.kind === 'admin_chat_jwt' &&
        active?.kind === 'admin_chat_jwt' &&
        active.generation === auth.principal_generation
    }
    if (binding.kind !== 'friend' || !binding.friend_id) return false
    try {
      const friend = await this.deps.getFriend?.(binding.friend_id)
      if (!friend) {
        await this.invalidatePrincipalBindingOnce(sourceKey, auth.principal_generation)
        return false
      }
      if (sourceKey === auth.manager_key || friend.permission === 'master') return true
      await this.invalidatePrincipalBindingOnce(sourceKey, auth.principal_generation)
      return false
    } catch {
      await this.invalidatePrincipalBindingOnce(sourceKey, auth.principal_generation)
      return false
    }
  }

  private async invalidatePrincipalBindingOnce(key: ManagerKey, generation: number): Promise<void> {
    this.activeAuthorizations.delete(key)
    this.resolved.delete(key)
    const current = this.bindings?.get(key)
    if (!current || current.generation !== generation) return
    await this.bindings?.bump(key)
  }

  private async refreshFriendAuthorization(key: ManagerKey): Promise<void> {
    const binding = this.bindings?.get(key)
    if (!binding || binding.kind !== 'friend' || !binding.friend_id) {
      this.activeAuthorizations.delete(key)
      return
    }
    try {
      const friend = await this.deps.getFriend?.(binding.friend_id)
      if (friend?.permission === 'master') {
        this.activeAuthorizations.set(key, { kind: 'friend_master', manager_key: key, friend_id: binding.friend_id, generation: binding.generation })
        return
      }
    } catch {
      // fall through to the one-time invalidation below
    }
    await this.invalidateAuthorizationOnce(key, binding.generation)
  }

  private async invalidateAuthorizationOnce(key: ManagerKey, generation: number): Promise<void> {
    const current = this.bindings?.get(key)
    const active = this.activeAuthorizations.get(key)
    this.activeAuthorizations.delete(key)
    // A prior failed validation already bumped the persisted generation; repeated
    // non-human wakes remain fail-closed without a write storm.
    if (!current || current.generation !== generation || !active || active.generation !== generation) return
    await this.bindings?.bump(key)
  }

  /** 该 key 最近一次解析结果;从未收到过人类消息则 undefined。 */
  get(key: ManagerKey): ResolvedPrincipal | undefined {
    return this.resolved.get(key)
  }
}
