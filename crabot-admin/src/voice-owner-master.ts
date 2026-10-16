import type { Friend } from 'crabot-shared'
import type { VoiceOwnerActivationRecord } from './voice-owner-store.js'

interface Dependencies {
  friends(): Friend[]
  persist(friend: Friend): Promise<void>
}
function conflict(message: string): never { throw Object.assign(new Error(message), { code: 'CONFLICT' }) }

/** Called only for VoiceAdmin's persisted, human-confirmed operation, never as a public management RPC. */
export async function commitVoiceOwnerMaster(record: VoiceOwnerActivationRecord, deps: Dependencies): Promise<string> {
  if (!record.samples_saved || record.binding_revoked) conflict('手机尚未持久保存所有者映射')
  const contact = record.activation.platform_user_id
  const identity = { channel_id: record.channel_id, platform_user_id: contact, platform_display_name: record.activation.owner.display_name }
  function current(): Friend | undefined {
    const friends = deps.friends()
    const masters = friends.filter(friend => friend.permission === 'master')
    if (masters.some(friend => friend.id !== record.target_friend_id) || masters.length > 1) conflict('原 Master 已变更，不能重新认主')
    const target = friends.find(friend => friend.id === record.target_friend_id)
    if (target && target.permission !== 'master' || !target && (!record.create_master || record.master_was_present)) conflict('原 Master 已删除或降级，不能重新认主')
    if (target?.channel_identities.some(value => value.channel_id === record.channel_id && value.platform_user_id !== contact)) conflict('Master 已有不同的同渠道身份，不能覆盖')
    if (friends.some(friend => friend.id !== record.target_friend_id && friend.channel_identities.some(value => value.channel_id === record.channel_id && value.platform_user_id === contact))) conflict('所有者联系人已被其他好友占用')
    return target
  }
  const existing = current()
  const bound = existing?.channel_identities.some(value => value.channel_id === record.channel_id && value.platform_user_id === contact)
  if (record.mode === 'legacy') {
    if (!existing || !bound || record.create_master) conflict('旧设备只能恢复现有 Master 的已绑定身份')
    return existing.id
  }
  const now = new Date().toISOString()
  const next: Friend = existing ? structuredClone(existing) : {
    id: record.target_friend_id, display_name: record.activation.owner.display_name, permission: 'master', channel_identities: [], created_at: now, updated_at: now,
  }
  if (!bound) { next.channel_identities.push(identity); next.updated_at = now }
  // Persist even after an earlier write failed: an in-memory binding alone is not a completion fact.
  await deps.persist(next)
  const saved = current()
  if (!saved?.channel_identities.some(value => value.channel_id === record.channel_id && value.platform_user_id === contact)) conflict('Master 关联在提交期间发生变化')
  return saved.id
}
