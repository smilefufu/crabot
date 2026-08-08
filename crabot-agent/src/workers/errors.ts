/**
 * Shared error types for worker adapters.
 * These are used by all adapter implementations (builtin, claude-code, codex)
 * to ensure consistent error handling and instanceof checks across implementations.
 */

import type { IncarnationEndReason, InitialInputDisposition, CliControlState, StateChangeReport } from './types'

/** Raised when sendInput is called on an incarnation that has already exited. */
export class WorkerExitedError extends Error {
  constructor(
    readonly worker_id: string,
    readonly seq: number,
    /**
     * adapter 侧已知的终止原因。harness 的 §5.3 透明接续在 revive 前要给"台账还没追上、
     * 仍记着非终态"的源化身补一条终态记录,这个字段就是它唯一能拿到的真值来源(此前
     * 只能硬编码 'completed',把 adapter 明知的 failed/crashed 丢掉)。
     *
     * 允许缺席:重启后 adapter 的常驻 runtime 表为空、连落盘 meta 都读不回来时,抛这个
     * 错误表达的是"这条化身对我而言与已终态等价",此时确实没有原因可给。
     */
    readonly ended_reason?: IncarnationEndReason,
  ) {
    super(`worker ${worker_id}#${seq} has exited`)
    this.name = 'WorkerExitedError'
  }
}


/** A CLI input surface prevented a safe automatic commit. The harness owns queue settlement. */
export class CliInputStallError extends Error {
  constructor(
    readonly disposition: Exclude<InitialInputDisposition, 'accepted'>,
    readonly control_state: CliControlState['kind'],
    readonly report?: StateChangeReport,
  ) {
    super(`CLI input stalled (${disposition}, ${control_state})`)
    this.name = 'CliInputStallError'
  }
}

/** Raised when a capability declared as false is invoked (e.g., fork on codex adapter). */
export class CapabilityNotSupportedError extends Error {
  constructor(
    readonly impl: string,
    readonly capability: string,
  ) {
    super(`${impl} does not support ${capability}`)
    this.name = 'CapabilityNotSupportedError'
  }
}
