import type {
  DialogObjectApplication,
  DialogObjectChannelSession,
  DialogObjectFriend,
  DialogObjectGroupEntry,
  DialogObjectPrivatePoolEntry,
  Friend,
  PendingMessage,
  SessionPermissionConfig,
} from './types.js'

interface PrivatePoolProjectionInput {
  friends: Iterable<Friend>
  pendingMessages: Iterable<PendingMessage>
  sessions: Iterable<DialogObjectChannelSession>
  sessionConfigs: ReadonlyMap<string, SessionPermissionConfig> | Iterable<[string, SessionPermissionConfig]>
  now?: Date
}

interface GroupProjectionInput {
  friends: Iterable<Friend>
  sessions: Iterable<DialogObjectChannelSession>
  sessionConfigs: ReadonlyMap<string, SessionPermissionConfig> | Iterable<[string, SessionPermissionConfig]>
}

export interface DialogObjectSessionPage {
  items: DialogObjectChannelSession[]
  pagination?: {
    page?: number
    page_size?: number
    total_items?: number
    total_pages?: number
  }
}

interface CollectDialogObjectSessionsInput<TChannel> {
  channels: Iterable<TChannel>
  type: DialogObjectChannelSession['type']
  pageSize?: number
  fetchPage: (
    channel: TChannel,
    page: number,
    pageSize: number,
    type: DialogObjectChannelSession['type']
  ) => Promise<DialogObjectSessionPage>
  onError?: (channel: TChannel, error: unknown) => void | Promise<void>
}

function toSessionConfigIdSet(
  sessionConfigs: ReadonlyMap<string, SessionPermissionConfig> | Iterable<[string, SessionPermissionConfig]>
): Set<string> {
  if (sessionConfigs instanceof Map) {
    return new Set(sessionConfigs.keys())
  }
  return new Set(Array.from(sessionConfigs, ([sessionId]) => sessionId))
}

function isPendingMessageActive(message: PendingMessage, now: Date): boolean {
  return new Date(message.expires_at).getTime() > now.getTime()
}

function buildAssignedIdentitySet(friends: Iterable<Friend>): Set<string> {
  const assignedIdentities = new Set<string>()
  for (const friend of friends) {
    for (const identity of friend.channel_identities) {
      assignedIdentities.add(`${identity.channel_id}:${identity.platform_user_id}`)
    }
  }
  return assignedIdentities
}

function buildFriendIdSet(friends: Iterable<Friend>): Set<string> {
  return new Set(Array.from(friends, (friend) => friend.id))
}

function buildMasterIdentitySet(friends: Iterable<Friend>): Set<string> {
  const masterIdentities = new Set<string>()
  for (const friend of friends) {
    if (friend.permission !== 'master') continue
    for (const identity of friend.channel_identities) {
      masterIdentities.add(`${identity.channel_id}:${identity.platform_user_id}`)
    }
  }
  return masterIdentities
}

function buildMasterFriendIdSet(friends: Iterable<Friend>): Set<string> {
  return new Set(
    Array.from(friends)
      .filter((friend) => friend.permission === 'master')
      .map((friend) => friend.id)
  )
}

function buildPendingMessageIndex(
  pendingMessages: Iterable<PendingMessage>,
  now: Date
): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const message of pendingMessages) {
    if (!isPendingMessageActive(message, now)) continue
    const key = `${message.channel_id}:${message.platform_user_id}`
    const ids = index.get(key) ?? []
    ids.push(message.id)
    index.set(key, ids)
  }
  return index
}

function isAssignedParticipant(
  session: DialogObjectChannelSession,
  participant: DialogObjectChannelSession['participants'][number],
  assignedFriendIds: Set<string>,
  assignedIdentities: Set<string>
): boolean {
  return (
    (participant.friend_id !== undefined && assignedFriendIds.has(participant.friend_id)) ||
    assignedIdentities.has(`${session.channel_id}:${participant.platform_user_id}`)
  )
}

function isMasterParticipant(
  session: DialogObjectChannelSession,
  participant: DialogObjectChannelSession['participants'][number],
  masterFriendIds: Set<string>,
  masterIdentities: Set<string>
): boolean {
  return (
    (participant.friend_id !== undefined && masterFriendIds.has(participant.friend_id)) ||
    masterIdentities.has(`${session.channel_id}:${participant.platform_user_id}`)
  )
}

function normalizeTotalPages(
  sessionPage: DialogObjectSessionPage,
  pageSize: number,
  currentPage: number
): number {
  const pagination = sessionPage.pagination
  if (pagination?.total_pages && pagination.total_pages > 0) {
    return Math.max(currentPage, pagination.total_pages)
  }
  if (pagination?.total_items !== undefined) {
    const effectivePageSize =
      pagination.page_size && pagination.page_size > 0 ? pagination.page_size : pageSize
    return Math.max(currentPage, Math.ceil(pagination.total_items / effectivePageSize), 1)
  }
  return currentPage
}

export async function collectDialogObjectChannelSessions<TChannel>(
  input: CollectDialogObjectSessionsInput<TChannel>
): Promise<DialogObjectChannelSession[]> {
  const sessions: DialogObjectChannelSession[] = []
  const pageSize = input.pageSize ?? 100

  for (const channel of input.channels) {
    try {
      let page = 1
      let totalPages = 1

      do {
        const result = await input.fetchPage(channel, page, pageSize, input.type)
        sessions.push(...result.items)
        totalPages = normalizeTotalPages(result, pageSize, page)
        page += 1
      } while (page <= totalPages)
    } catch (error) {
      await input.onError?.(channel, error)
    }
  }

  return sessions
}

export function projectFriendDialogObjects(friends: Iterable<Friend>): DialogObjectFriend[] {
  return Array.from(friends, (friend) => ({
    id: friend.id,
    display_name: friend.display_name,
    permission: friend.permission,
    permission_template_id: friend.permission_template_id,
    identities: [...friend.channel_identities],
    status: friend.channel_identities.length > 0 ? 'active' : 'no_channel',
    created_at: friend.created_at,
    updated_at: friend.updated_at,
  }))
}

export function projectApplicationDialogObjects(
  pendingMessages: Iterable<PendingMessage>,
  now: Date = new Date()
): DialogObjectApplication[] {
  return Array.from(pendingMessages)
    .filter((message) => isPendingMessageActive(message, now))
    .map((message) => ({
      id: message.id,
      intent: message.intent,
      channel_id: message.channel_id,
      platform_user_id: message.platform_user_id,
      platform_display_name: message.platform_display_name,
      content_preview: message.content_preview,
      source_session_id: message.raw_message.session.session_id,
      received_at: message.received_at,
      expires_at: message.expires_at,
    }))
}

export function projectPrivatePoolDialogObjects(input: PrivatePoolProjectionInput): DialogObjectPrivatePoolEntry[] {
  const friends = Array.from(input.friends)
  const assignedFriendIds = buildFriendIdSet(friends)
  const assignedIdentities = buildAssignedIdentitySet(friends)
  const pendingMessageIndex = buildPendingMessageIndex(input.pendingMessages, input.now ?? new Date())
  const sessionConfigIds = toSessionConfigIdSet(input.sessionConfigs)

  return Array.from(input.sessions)
    .filter((session) => session.type === 'private')
    .filter((session) =>
      !session.participants.some((participant) =>
        isAssignedParticipant(session, participant, assignedFriendIds, assignedIdentities)
      )
    )
    .map((session) => ({
      ...session,
      has_session_config: sessionConfigIds.has(session.id),
      matching_pending_application_ids: Array.from(
        new Set(
          session.participants.flatMap((participant) =>
            pendingMessageIndex.get(`${session.channel_id}:${participant.platform_user_id}`) ?? []
          )
        )
      ),
    }))
}

export function projectGroupDialogObjects(input: GroupProjectionInput): DialogObjectGroupEntry[] {
  const friends = Array.from(input.friends)
  const masterFriendIds = buildMasterFriendIdSet(friends)
  const masterIdentities = buildMasterIdentitySet(friends)
  const sessionConfigIds = toSessionConfigIdSet(input.sessionConfigs)

  return Array.from(input.sessions)
    .filter((session) => session.type === 'group')
    .map((session) => {
      const master_in_group = session.participants.some((participant) =>
        isMasterParticipant(session, participant, masterFriendIds, masterIdentities)
      )

      return {
        ...session,
        participant_count: session.participants.length,
        has_session_config: sessionConfigIds.has(session.id),
        master_in_group,
      }
    })
    .filter((session) => session.master_in_group)
}
