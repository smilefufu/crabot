import type { WorkerUiActionDescriptor } from '../types.js'

export type TerminalInteraction =
  | { kind: 'none' }
  | { kind: 'automatic'; family: 'claude_exit_plan'; fingerprint: string }
  | {
      kind: 'manager_required'
      family: string
      fingerprint: string
      actions: readonly WorkerUiActionDescriptor[]
    }
