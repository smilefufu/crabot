/**
 * 人类消息发起人身份 —— 解析、按 key 缓存,以及由它派生的四样东西
 * (protocol-agent-v3.md §3 台账聚合键、§4.2/§4.3 对话对象档案与记忆档位、§8.2 权限身份)。
 *
 * ## 为什么需要单独一层
 *
 * `ManagerRegistryDeps` 的 `dialogObjectIdFor` / `toolFace` / `promptInputs` 全是**同步**
 * 签名——它们被 `ManagerLoop` 每轮 turn 同步调用(`EngineOptions.systemPrompt` 的 Resolvable
 * 必须同步)。而这几样东西的原料都是异步 RPC:admin 的 `resolve_principal_permissions`、
 * admin 的 `get_session_config`、memory 的 `get_scene_profile`。
 *
 * 解法**不是**把那些签名改成异步,而是"在唤醒边界解析一次、按 `ManagerKey` 缓存,同步
 * thunk 只读缓存"。这条路成立的前提是:**入站链路本来就知道"谁在说话"**——
 * `channel.message_authorized` 的 payload 自带完整 `friend` 对象,而入站点本来就在 async
 * 上下文里。缺的从来不是"能不能拿到 friend",只是"没有把它往下传"。
 *
 * ## 三个消费者
 *
 * 1. **台账聚合键**(`dialogObjectIdFor`):私聊必须收敛成 `friend:<friend_id>`,同一个人
 *    跨 channel 共享一份 worker 台账;群聊是 `group:<channel>:<session>`;系统线程归
 *    master 的对话对象——否则 master 在私聊里问进度时看不到系统线程派出的 worker(§4.4)。
 * 2. **记忆档位**(`ResolvedPrincipal.memory`):决定 manager 与它派出的 worker 写记忆时
 *    的 visibility / scopes。放着不管的现状是 `{visibility:'public', scopes:[]}`
 *    ——群 A 的对话会以 public 落记忆、群 B 读得到,是跨会话信息泄漏。
 * 3. **权限档位**(`ResolvedPrincipal.permissions`):manager 算好、随 spawn 下传给 worker
 *    (§8.2)。**worker 不需要知道 friend 是谁**,它只拿到一份算好的 `ResolvedPermissions`。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §3、§4.3、§4.4、§8.2
 */

import type { Friend, MemoryPermissions, ResolvedPermissions, RuntimeSceneProfile } from '../types.js'
import { dialogObjectIdForGroup, dialogObjectIdForPrivate } from '../workers/harness/ledger-types.js'
import type { DialogObjectId } from '../workers/harness/ledger-types'
import type { ManagerKey } from './types.js'

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
  /** admin `resolve_principal_permissions`;失败返回 null(调用方 fail-soft)。 */
  readonly resolvePermissions: (p: {
    senderFriend?: Friend
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
  /** master 的 friend id(系统线程台账归档键);未知返回 undefined。 */
  readonly masterFriendId: () => Promise<string | undefined>
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
  /** master friend id 是实例级常量,解析一次即长期有效;未解析出来之前为 undefined。 */
  private masterFriendId: string | undefined

  constructor(
    private readonly deps: PrincipalResolverDeps,
    private readonly systemThreadKey: ManagerKey,
  ) {}

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
          ...(principal.friend ? { senderFriend: principal.friend } : {}),
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

    // 顺带把 master friend id 刷出来(系统线程的台账归档键要用)。它是实例级常量,
    // 解析成功一次就长期有效;失败只是让系统线程暂时退回旧的 group 形状,不影响本次唤醒。
    if (this.masterFriendId === undefined) {
      try {
        this.masterFriendId = await this.deps.masterFriendId()
      } catch (err) {
        console.warn('[manager-principal] 解析 master friend id 失败,系统线程台账暂用旧归档键:', err)
      }
    }

    return entry
  }

  /** 该 key 最近一次解析结果;从未收到过人类消息则 undefined。 */
  get(key: ManagerKey): ResolvedPrincipal | undefined {
    return this.resolved.get(key)
  }

  /**
   * 台账聚合键(§3)。三条规则:
   *
   * 1. **系统线程** → `friend:<master_id>`。§4.4 要求未配目标 session 的 scheduled 任务
   *    台账归 master 对话对象,否则 master 在私聊里问进度时看不到这些 worker。
   *    master id 尚未解析出来时**退回旧的 group 形状**——不猜、不阻塞。
   * 2. **私聊** → `friend:<friend_id>`,同一个人跨 channel 共享一份台账。
   * 3. **群聊 / 身份未知** → `group:<channel>:<session>`。
   */
  dialogObjectIdFor(key: ManagerKey): DialogObjectId {
    const { channelId, sessionId } = splitManagerKey(key)

    if (key === this.systemThreadKey) {
      return this.masterFriendId
        ? dialogObjectIdForPrivate(this.masterFriendId)
        : dialogObjectIdForGroup(channelId, sessionId)
    }

    const entry = this.resolved.get(key)
    if (entry?.principal.sessionType === 'private' && entry.principal.friend) {
      return dialogObjectIdForPrivate(entry.principal.friend.id)
    }
    return dialogObjectIdForGroup(channelId, sessionId)
  }
}
