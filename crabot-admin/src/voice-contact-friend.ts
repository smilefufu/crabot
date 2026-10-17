import type { Friend, VoiceRegistration } from 'crabot-shared'

interface Dependencies { friends(): Friend[]; persist(friend: Friend): Promise<void> }

/** Neutral identity persistence; the caller owns authorization and the pending-identity gate. */
export async function commitVoiceContactFriend(channelId: string, registration: VoiceRegistration, friendId: string, create: boolean, deps: Dependencies): Promise<void> {
  const identity = { channel_id: channelId, platform_user_id: registration.platform_user_id, platform_display_name: registration.display_name }
  const current = () => {
    const friends = deps.friends(), target = friends.find(friend => friend.id === friendId)
    if (!target && !create || target?.channel_identities.some(value => value.channel_id === channelId && value.platform_user_id !== identity.platform_user_id)
      || friends.some(friend => friend.id !== friendId && friend.channel_identities.some(value => value.channel_id === channelId && value.platform_user_id === identity.platform_user_id))) {
      throw new Error('CONFLICT: 目标好友不存在或已有不同的渠道身份')
    }
    if (create && target && (target.permission !== 'normal' || target.display_name !== registration.display_name
      || target.channel_identities.length !== 1 || target.channel_identities[0].platform_user_id !== identity.platform_user_id)) throw new Error('CONFLICT: 原预留好友已变化')
    return target
  }
  const target = current(), now = new Date().toISOString()
  const next: Friend = target ? structuredClone(target) : { id: friendId, display_name: registration.display_name, permission: 'normal', channel_identities: [], created_at: now, updated_at: now }
  if (!next.channel_identities.some(value => value.channel_id === channelId && value.platform_user_id === identity.platform_user_id)) {
    next.channel_identities.push(identity); next.updated_at = now
  }
  await deps.persist(next)
  if (!current()?.channel_identities.some(value => value.channel_id === channelId && value.platform_user_id === identity.platform_user_id)) throw new Error('CONFLICT: 好友关联在保存期间变化')
}
