import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson } from 'crabot-shared'
import { AsyncMutex } from '../workers/async-mutex.js'
import type { ConversationRequestRecord } from './conversation-request.js'
import { parseRequestDeliveryAttempt, readRequestDeliveryConfirmation, readRequestDeliveryFile, isRequestDeliveryReceipt, type RequestDeliveryAttempt as Attempt, type RequestDeliveryReceipt as Receipt } from './request-runtime-metadata.js'


/** Request-local outbox responsibility. Unknown sends are barriers, never automatic retries. */
export class RequestDeliveryStore {
  private readonly mutex = new AsyncMutex()
  private readonly pending: string
  constructor(private readonly root: string, private readonly request: ConversationRequestRecord) { this.pending = path.join(root, 'delivery-pending.json') }

  async unsettled(): Promise<boolean> {
    const value = await this.read(this.pending)
    if (!value) return false
    const attempt = this.attempt(value)
    const confirmed = await this.confirmed(attempt)
    if (!confirmed) return true
    await fs.rm(this.pending) // Mechanical acknowledgement of a durable receipt, no external send.
    return false
  }
  async send(target: Attempt['target'], operation: { name: string; input: Record<string, unknown> }, authorize: () => Promise<unknown>, send: () => Promise<unknown>): Promise<Receipt> {
    return this.mutex.run(async () => {
      if (await this.unsettled()) throw new Error('DELIVERY_OUTCOME_UNKNOWN')
      const { post_send_action: _post, ...input } = operation.input
      const attempt: Attempt = { schema_version: 1, request_id: this.request.request_id, source_sha256: this.request.source_sha256,
        operation_id: sha256CanonicalJson([this.request.request_id, operation.name, input, target]), target }
      const confirmed = await this.confirmed(attempt)
      if (confirmed) return confirmed
      await fs.mkdir(path.join(this.root, 'deliveries'), { recursive: true, mode: 0o700 })
      const handle = await fs.open(this.pending, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(attempt)); await handle.sync() } finally { await handle.close() }
      let invoked = false
      try {
        await authorize()
        invoked = true
        const response = await send()
        if (!isRequestDeliveryReceipt(response)) throw new Error('DELIVERY_OUTCOME_UNKNOWN')
        const receipt: Receipt = { platform_message_id: response.platform_message_id, sent_at: response.sent_at }
        const file = this.file(attempt.operation_id), temporary = `${file}.${randomUUID()}.tmp`
        try {
          const output = await fs.open(temporary, 'wx', 0o600)
          try { await output.writeFile(JSON.stringify({ ...attempt, receipt })); await output.sync() } finally { await output.close() }
          await fs.rename(temporary, file)
        } finally { await fs.rm(temporary, { force: true }) }
        await fs.rm(this.pending)
        return receipt
      } catch (error) { if (!invoked) await fs.rm(this.pending); throw error }
    })
  }
  private file(id: string): string { return path.join(this.root, 'deliveries', `${id}.json`) }
  private attempt(value: unknown): Attempt { return parseRequestDeliveryAttempt(value, this.request) }
  private confirmed(attempt: Attempt): Promise<Receipt | null> { return readRequestDeliveryConfirmation(this.root, this.request, attempt) }
  private read(file: string): Promise<unknown | null> { return readRequestDeliveryFile(file) }
}
