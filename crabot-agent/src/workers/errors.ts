/**
 * Shared error types for worker adapters.
 * These are used by all adapter implementations (builtin, claude-code, codex)
 * to ensure consistent error handling and instanceof checks across implementations.
 */

/** Raised when sendInput is called on an incarnation that has already exited. */
export class WorkerExitedError extends Error {
  constructor(
    readonly worker_id: string,
    readonly seq: number,
  ) {
    super(`worker ${worker_id}#${seq} has exited`)
    this.name = 'WorkerExitedError'
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

/** Raised when workspace validation fails. */
export class InvalidWorkspaceError extends Error {
  constructor(
    readonly reason: string,
  ) {
    super(`invalid workspace: ${reason}`)
    this.name = 'InvalidWorkspaceError'
  }
}
