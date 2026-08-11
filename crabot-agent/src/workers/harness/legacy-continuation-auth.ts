import type { ResolvedPermissions } from '../../types.js'
import { isManagerKey } from './ledger-store.js'
import type { ManagerKey } from './ledger-types.js'
import { isResolvedPermissionsSnapshot } from './context-store.js'

/** Opaque control-plane credential attached only to one in-process inbox item. */
export interface LegacyContinuationAuth {
  readonly manager_key: ManagerKey
  readonly principal_kind: 'friend' | 'admin_chat_jwt'
  readonly principal_generation: number
  readonly principal_permissions: ResolvedPermissions
}

export function isLegacyContinuationAuth(value: unknown): value is LegacyContinuationAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const auth = value as Record<string, unknown>
  const keys = Object.keys(auth).sort()
  const expected = [
    'manager_key',
    'principal_generation',
    'principal_kind',
    'principal_permissions',
  ]
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]) &&
    typeof auth.manager_key === 'string' && isManagerKey(auth.manager_key) &&
    (auth.principal_kind === 'friend' || auth.principal_kind === 'admin_chat_jwt') &&
    typeof auth.principal_generation === 'number' &&
    Number.isInteger(auth.principal_generation) && auth.principal_generation > 0 &&
    isResolvedPermissionsSnapshot(auth.principal_permissions)
}
