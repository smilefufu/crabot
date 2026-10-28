import type { OnboarderFinishResult, FriendId, ModuleId } from 'crabot-shared'

export interface OnboardFinishResponseInput {
  finishResult: OnboarderFinishResult
  instance: { id: ModuleId } & Record<string, unknown>
  masterFriendId: FriendId | undefined
  masterDisplayName: string | undefined
  pushSent: boolean
}

export function buildOnboardFinishResponse(input: OnboardFinishResponseInput) {
  const { finishResult, instance, masterFriendId, masterDisplayName, pushSent } = input
  return {
    instance,
    ...(finishResult.authorized_identity ? { authorized_identity: finishResult.authorized_identity } : {}),
    ...(masterFriendId ? { master_friend_id: masterFriendId } : {}),
    ...(masterDisplayName !== undefined ? { master_display_name: masterDisplayName } : {}),
    ...(finishResult.scope_grant_url ? { scope_grant_url: finishResult.scope_grant_url } : {}),
    ...(finishResult.event_subscription ? { event_subscription: finishResult.event_subscription } : {}),
    push_sent: pushSent,
  }
}
