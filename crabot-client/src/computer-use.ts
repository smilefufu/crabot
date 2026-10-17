import { z } from 'zod'
import type { HttpClient, RequestOptions } from './http.js'

// protocol-admin §3.16.0; no setup/permission effects occur during schema parsing.
const Permission = z.enum(['granted', 'missing', 'unknown', 'not_applicable'])
const Capture = z.looseObject({ status: z.enum(['verified', 'failed', 'unverified']), verified_at: z.string().optional(), reason: z.string().optional() })
export const ComputerUseSetupStatusSchema = z.looseObject({
  enabled: z.boolean(), standard: z.boolean(),
  host: z.looseObject({ platform: z.string(), hostname: z.string(), session: z.enum(['active', 'unavailable', 'unknown']) }),
  permissions: z.looseObject({ accessibility: Permission, screen_recording: Permission }), capture: Capture,
  runtime: z.looseObject({ state: z.enum(['uninitialized', 'connecting', 'ready', 'quarantined']), reason: z.string().optional(),
    checks: z.array(z.looseObject({ name: z.string(), status: z.enum(['pass', 'fail', 'skip']) })).optional(),
    capture: Capture.extend({ setup_id: z.string() }).optional(),
  }),
  setup: z.looseObject({ setup_id: z.string(), phase: z.enum(['permissions', 'capture', 'connecting', 'ready', 'failed', 'cancelled']),
    expires_at: z.string(), reason: z.string().optional() }).optional(),
  app_path: z.string().optional(), reason: z.string().optional(),
})
export type ComputerUseSetupStatus = z.infer<typeof ComputerUseSetupStatusSchema>

export class ComputerUseClient {
  constructor(private readonly http: HttpClient) {}
  status(options?: RequestOptions) { return this.http.request('/computer-use/setup', ComputerUseSetupStatusSchema, { ...options, method: 'GET' }) }
  start(options?: RequestOptions) { return this.action('start', options) }
  reveal(options?: RequestOptions) { return this.action('reveal_app', options) }
  private action(action: 'start' | 'reveal_app', options?: RequestOptions) {
    const headers = new Headers(options?.headers); headers.set('Content-Type', 'application/json')
    return this.http.request('/computer-use/setup', ComputerUseSetupStatusSchema, { ...options, method: 'POST',
      headers, body: JSON.stringify({ action }) })
  }
  cancel(setup_id: string, options?: RequestOptions) {
    z.string().min(1).parse(setup_id)
    const headers = new Headers(options?.headers); headers.set('Content-Type', 'application/json')
    return this.http.request('/computer-use/setup', ComputerUseSetupStatusSchema, { ...options, method: 'DELETE',
      headers, body: JSON.stringify({ setup_id }) })
  }
}
