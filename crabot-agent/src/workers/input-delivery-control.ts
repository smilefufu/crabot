import type { SendInputOptions } from './types.js'

export class InputDeliveryInterruptedError extends Error {
  constructor(
    message: string,
    readonly certainty: 'not_delivered' | 'unknown',
  ) {
    super(message)
    this.name = 'InputDeliveryInterruptedError'
  }
}

export function assertInputDeliveryActive(
  opts: SendInputOptions | undefined,
  certainty: 'not_delivered' | 'unknown',
): void {
  if (!opts?.delivery_id) return
  if (opts.signal?.aborted) {
    throw new InputDeliveryInterruptedError(
      `input delivery ${opts.delivery_id} was cancelled before the next adapter action`,
      certainty,
    )
  }
  if (opts.deadline_at && Date.now() >= Date.parse(opts.deadline_at)) {
    throw new InputDeliveryInterruptedError(
      `input delivery ${opts.delivery_id} exceeded its deadline before the next adapter action`,
      certainty,
    )
  }
}
