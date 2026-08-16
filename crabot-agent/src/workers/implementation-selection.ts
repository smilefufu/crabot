/**
 * Worker implementation 纯选择器（P6-C plan §5；protocol-agent-v3 §6.5）。
 *
 * 固定顺序（协议确定性）：
 * 1. 显式 impl：只检查自己，不 fallback；
 * 2. 省略 impl：default enabled+ready → default；
 * 3. default 不可用 → builtin → claude-code → codex 第一个 enabled+ready；
 * 4. 无候选 → WORKER_IMPLEMENTATION_NOT_READY。
 *
 * 纯函数：不读 registry、不做 detect、不解析 preference 文本。
 * excludedImpls 只用于 handoff「该 worker 已用过的实现」限制，不影响全局 ready。
 */

import type {
  WorkerImplId,
  WorkerImplementationConfig,
  WorkerImplementationStatus,
} from './types.js'

export const FIXED_FALLBACK_ORDER: readonly WorkerImplId[] = ['builtin', 'claude-code', 'codex']

export class WorkerNotReadyError extends Error {
  readonly code = 'WORKER_IMPLEMENTATION_NOT_READY'
  readonly details: {
    requested_impl?: WorkerImplId
    ready_impls: WorkerImplId[]
    reasons: Partial<Record<WorkerImplId, string>>
  }

  constructor(
    requested: WorkerImplId | undefined,
    ready: WorkerImplId[],
    reasons: Partial<Record<WorkerImplId, string>>,
  ) {
    super(requested
      ? `Worker implementation not ready: ${requested}`
      : 'No ready worker implementation')
    this.details = { ...(requested ? { requested_impl: requested } : {}), ready_impls: ready, reasons }
  }
}

export interface SelectionInput {
  requestedImpl?: WorkerImplId
  config: WorkerImplementationConfig
  statuses: ReadonlyMap<WorkerImplId, WorkerImplementationStatus> | readonly WorkerImplementationStatus[]
  excludedImpls?: ReadonlySet<WorkerImplId>
}

function statusMap(input: SelectionInput['statuses']): ReadonlyMap<WorkerImplId, WorkerImplementationStatus> {
  if (input instanceof Map) return input as ReadonlyMap<WorkerImplId, WorkerImplementationStatus>
  const out = new Map<WorkerImplId, WorkerImplementationStatus>()
  for (const status of input as readonly WorkerImplementationStatus[]) out.set(status.impl, status)
  return out
}

function readyImpls(statuses: ReadonlyMap<WorkerImplId, WorkerImplementationStatus>, excluded?: ReadonlySet<WorkerImplId>): WorkerImplId[] {
  return FIXED_FALLBACK_ORDER.filter((impl) => !excluded?.has(impl) && statuses.get(impl)?.ready === true)
}

function reasons(statuses: ReadonlyMap<WorkerImplId, WorkerImplementationStatus>): Partial<Record<WorkerImplId, string>> {
  const out: Partial<Record<WorkerImplId, string>> = {}
  for (const impl of FIXED_FALLBACK_ORDER) {
    const status = statuses.get(impl)
    out[impl] = status?.ready ? 'ready' : (status?.degraded ?? status?.detail ?? 'not ready')
  }
  return out
}

export function selectWorkerImplementation(input: SelectionInput): WorkerImplId {
  const statuses = statusMap(input.statuses)
  const excluded = input.excludedImpls

  // 1. 显式：只检查自己，绝不 fallback
  if (input.requestedImpl !== undefined) {
    const status = statuses.get(input.requestedImpl)
    const ready = status?.ready === true && !excluded?.has(input.requestedImpl)
    if (ready) return input.requestedImpl
    throw new WorkerNotReadyError(input.requestedImpl, readyImpls(statuses, excluded), reasons(statuses))
  }

  // 2. 省略：default 优先
  const defaultImpl = input.config.default_impl
  const defaultStatus = statuses.get(defaultImpl)
  if (defaultStatus?.ready === true && !excluded?.has(defaultImpl)) return defaultImpl

  // 3. 固定顺序
  const candidates = readyImpls(statuses, excluded)
  if (candidates.length > 0) return candidates[0]

  // 4. 无候选
  throw new WorkerNotReadyError(undefined, [], reasons(statuses))
}
