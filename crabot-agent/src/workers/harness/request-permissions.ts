import type { ResolvedPermissions } from '../../types.js'
import type { RequestPermissionSource } from '../../manager/request-permission-sources.js'

/** Bound to the same original source, without freezing its historical permission values. */
export async function boundedRequestPermissions(original: RequestPermissionSource, current: RequestPermissionSource): Promise<ResolvedPermissions> {
  if (original.kind !== current.kind || original.subject_id !== current.subject_id) throw new Error('Cannot combine different request permission sources')
  return structuredClone(current.resolved)
}
