import type { BgEntityRegistry } from '../../engine/bg-entities/registry.js'
import type { BgShellRegistryRecord } from '../../engine/bg-entities/types.js'
import type { SystemInjectionEvent } from '../../engine/types.js'
import { sleep } from '../../engine/retry-utils.js'
import { killShellTree } from '../../engine/bg-entities/bg-shell.js'

/** One child owns its shell inputs; a burst ending never discards these receipts. */
export class ChildShellSession {
  private pending = false
  private readonly offered = new Map<string, string>()
  private readonly consumed = new Set<string>()

  constructor(
    private readonly registry: BgEntityRegistry,
    private readonly childId: string,
    private readonly signal: AbortSignal,
  ) {}

  notify(): void { this.pending = true }
  hasPending = (): boolean => this.pending

  private async shells(): Promise<BgShellRegistryRecord[]> {
    return (await this.registry.list({ type: 'shell' })).filter(
      (record): record is BgShellRegistryRecord => record.type === 'shell' && record.owner.subagent_id === this.childId,
    )
  }

  drain = async (): Promise<string[]> => {
    const inputs: string[] = []
    for (const shell of await this.shells()) {
      if (shell.exit_notification?.status !== 'pending' || this.consumed.has(shell.entity_id)) continue
      const text = `<bg-notification>\n${shell.entity_id} status=${shell.status}, exit_code=${shell.exit_code}; use Output to read output.\n</bg-notification>`
      this.offered.set(text, shell.entity_id)
      inputs.push(text)
    }
    this.pending = false
    return inputs
  }

  onInjection = (event: SystemInjectionEvent): void => {
    if (event.type !== 'external_input') return
    const id = this.offered.get(event.text)
    if (id) {
      this.consumed.add(id)
      this.offered.delete(event.text)
      void this.settleConsumed().catch(error => console.error('[child-shell-session] receipt pending:', error))
    }
  }

  private async settleConsumed(): Promise<void> {
    for (const id of this.consumed) {
      const record = await this.registry.get(id)
      if (record?.exit_notification?.status === 'pending') await this.registry.settleExitNotification(id, 'delivered')
    }
  }

  /** No model polling: resume for parent input or an unconsumed Shell notification. */
  async continueAfterTurn(hasParentInput: () => boolean = () => false): Promise<boolean> {
    while (!this.signal.aborted) {
      if (hasParentInput()) return true
      try {
        await this.settleConsumed()
        const shells = await this.shells()
        if (hasParentInput()) return true
        if (shells.some(s => s.exit_notification?.status === 'pending' && !this.consumed.has(s.entity_id))) return true
        if (!shells.some(s => s.status === 'running' || s.exit_notification?.status === 'pending')) return false
      } catch (error) {
        // Keep the child active while receipt storage is unavailable; never claim completion.
        console.error('[child-shell-session] receipt reconciliation pending:', error)
      }
      await sleep(2_000, this.signal)
    }
    return false
  }

  async close(): Promise<void> {
    for (const shell of await this.shells()) {
      if (shell.status === 'running') killShellTree(shell.pgid)
      if (shell.exit_notification?.status === 'pending') {
        await this.registry.settleExitNotification(shell.entity_id,
          this.consumed.has(shell.entity_id) ? 'delivered' : 'dead_letter',
          this.consumed.has(shell.entity_id) ? undefined : 'subagent_execution_ended')
      }
    }
  }
}
