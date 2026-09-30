import type { BgEntityRegistry } from '../../engine/bg-entities/registry.js'
import { ChildShellSession } from './child-shell-session.js'

/** Parent input and Shell receipts share an execution boundary, not acknowledgement state. */
export class ChildExecutionSession {
  private readonly shells: ChildShellSession
  private readonly inputs: string[] = []
  private closing = false

  constructor(registry: BgEntityRegistry, childId: string, private readonly signal: AbortSignal) {
    this.shells = new ChildShellSession(registry, childId, signal)
  }

  enqueue(text: string): boolean {
    if (this.closing || this.signal.aborted) return false
    this.inputs.push(`[parent input]\n${text}`)
    return true
  }

  notifyShell(): void { this.shells.notify() }
  hasPending = (): boolean => this.inputs.length > 0 || this.shells.hasPending()
  onInjection: ChildShellSession['onInjection'] = event => this.shells.onInjection(event)

  drain = async (): Promise<string[]> => {
    const notifications = await this.shells.drain()
    return [...notifications, ...this.inputs.splice(0)]
  }

  async continueAfterTurn(): Promise<boolean> {
    const ready = await this.shells.continueAfterTurn(() => this.inputs.length > 0)
    if (!this.signal.aborted && (ready || this.inputs.length > 0)) return true
    // No await between the final queue check and closing admission.
    this.stopAcceptingInput()
    return false
  }

  stopAcceptingInput = (): void => { this.closing = true }

  async close(): Promise<void> {
    this.stopAcceptingInput()
    this.inputs.length = 0
    await this.shells.close()
  }
}
