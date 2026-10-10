import path from 'node:path'
import { realpathSync } from 'node:fs'
import type { ResolvedPermissions } from '../types.js'
import type { WorkerImplId } from './types.js'

export function executionAdmission(impl: WorkerImplId, principal?: ResolvedPermissions | null, platform = process.platform): { status: 'allowed' | 'blocked' | 'unknown'; reasons: string[] } {
  if (!principal) return { status: 'unknown', reasons: ['缺少可信主体授权'] }
  if (impl === 'builtin') return { status: 'allowed', reasons: [] }
  const reasons: string[] = []
  if (!principal.tool_access.file_io || !principal.tool_access.shell) reasons.push('原生 CLI 需要 file_io 与 shell 授权')
  let fullHost = false
  if (platform === 'linux' || platform === 'darwin') {
    try { fullHost = principal.storage?.access === 'readwrite' && path.isAbsolute(principal.storage.workspace_path) && realpathSync(principal.storage.workspace_path) === '/' } catch { /* Unverifiable scope is not admission. */ }
  }
  if (!fullHost) reasons.push('原生 CLI 需要可核实的 Linux/macOS 主机根目录读写范围；当前范围不受原生执行器约束')
  return { status: reasons.length ? 'blocked' : 'allowed', reasons }
}

export function assertExecutionPolicy(impl: WorkerImplId, principal?: ResolvedPermissions | null, newWorker = false): void {
  if (impl === 'builtin' && !newWorker) return
  const admission = executionAdmission(impl, principal)
  if (admission.status === 'allowed') return
  const code = admission.status === 'unknown' ? 'CAPABILITY_UNKNOWN' : 'EXECUTION_POLICY_UNSUPPORTED'
  throw Object.assign(new Error(`${code}: ${admission.reasons.join('；')}`), { code })
}
