import { RpcError } from 'crabot-shared'

interface PermissionSession {
  channel_id: string
  id: string
  type: 'private' | 'group'
}

export async function resolvePermissionSessionTarget(
  input: { channel_id?: string; session_id: string; session_type: 'private' | 'group' },
  deps: { channelIds: () => string[]; getSession: (channelId: string, sessionId: string) => Promise<PermissionSession> },
): Promise<{ channel_id: string; session_id: string }> {
  if (!input || typeof input.session_id !== 'string' || !input.session_id.trim()
    || !['private', 'group'].includes(input.session_type)
    || (input.channel_id !== undefined && (typeof input.channel_id !== 'string' || !input.channel_id.trim()))) {
    throw new RpcError('INVALID_PARAMS', 'A valid permission target is required')
  }
  const getSession = async (channelId: string): Promise<PermissionSession> => {
    if (channelId === 'admin-web') {
      if (!['admin-chat', 'system-tasks'].includes(input.session_id)) throw new RpcError('NOT_FOUND', 'Session not found')
      return { channel_id: channelId, id: input.session_id, type: 'private' }
    }
    let session: PermissionSession
    try {
      session = await deps.getSession(channelId, input.session_id)
    } catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') throw new RpcError('NOT_FOUND', 'Session not found')
      throw new RpcError('SERVICE_UNAVAILABLE', 'Cannot verify permission target')
    }
    if (!session || session.id !== input.session_id || session.channel_id !== channelId
      || !['private', 'group'].includes(session.type)) throw new RpcError('INVALID_PARAMS', 'Permission target identity mismatch')
    return session
  }

  let session: PermissionSession
  if (input.channel_id !== undefined) {
    session = await getSession(input.channel_id)
  } else {
    console.warn('[Admin] Deprecated permission request without channel_id; verifying unique ownership')
    const matches: PermissionSession[] = []
    // A NOT_FOUND response is negative evidence. Offline channels are not.
    for (const channelId of new Set(['admin-web', ...deps.channelIds()])) {
      try {
        matches.push(await getSession(channelId))
      } catch (error) {
        if ((error as { code?: string }).code === 'NOT_FOUND') continue
        throw new RpcError('SERVICE_UNAVAILABLE', 'Cannot prove unique session ownership')
      }
    }
    if (matches.length !== 1) throw new RpcError('INVALID_PARAMS', 'Session ownership is missing or ambiguous; provide channel_id')
    session = matches[0]
  }
  if (session.type !== input.session_type) throw new RpcError('INVALID_PARAMS', 'Permission target type mismatch')
  return { channel_id: session.channel_id, session_id: session.id }
}
