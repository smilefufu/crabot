import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RequestIdSchema } from 'crabot-client'

export function correlateHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const incoming = req.headers['x-crabot-request-id']
  const parsed = RequestIdSchema.safeParse(incoming)
  const id = parsed.success ? parsed.data : randomUUID()
  res.setHeader('X-Crabot-Request-Id', id)
  const started = Date.now()
  res.once?.('finish', () => {
    try {
      console.info('[AdminHTTP] ' + JSON.stringify({ request_id: id, method: req.method, status: res.statusCode, duration_ms: Date.now() - started }))
    } catch { /* diagnostics cannot change a completed HTTP operation */ }
  })
}
