import { normalizeToolAccessUpdate as normalize, RpcError } from 'crabot-shared'

/** Keep the shared compatibility validation independent of the server transport. */
export function normalizeToolAccessUpdate(...args: Parameters<typeof normalize>): ReturnType<typeof normalize> {
  try { return normalize(...args) } catch (error) {
    if ((error as { code?: string }).code === 'INVALID_PARAMS') throw new RpcError('INVALID_PARAMS', (error as Error).message)
    throw error
  }
}
