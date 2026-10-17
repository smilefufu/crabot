import { z } from 'zod'

const InstanceId = z.string().regex(/^[a-f0-9]{64}$/)
const Generation = z.uuid()
const Nonce = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
export const DesktopErrorCodeSchema = z.enum([
  'DESKTOP_UNAUTHORIZED', 'DESKTOP_STALE_INSTANCE', 'DESKTOP_CHALLENGE_EXPIRED',
  'DESKTOP_REPLAY', 'DESKTOP_PROTOCOL_ERROR', 'DESKTOP_UNAVAILABLE',
])
export function isLoopbackAdminOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
  } catch { return false }
}
export const LoopbackAdminOriginSchema = z.string().refine(isLoopbackAdminOrigin, 'Expected a loopback Admin origin')
export const DesktopChallengeSchema = z.strictObject({
  type: z.literal('challenge'), protocol_version: z.literal(1), instance_id: InstanceId,
  generation: Generation, challenge: Nonce, expires_at: z.iso.datetime(),
})
export const DesktopSessionRequestSchema = z.strictObject({
  type: z.literal('open_session'), protocol_version: z.literal(1), instance_id: InstanceId,
  generation: Generation, challenge: Nonce, client_nonce: Nonce,
})
export const DesktopSessionResponseSchema = z.strictObject({
  type: z.literal('session'), protocol_version: z.literal(1), instance_id: InstanceId,
  generation: Generation, admin_url: LoopbackAdminOriginSchema, token: z.string().min(1), expires_at: z.iso.datetime(),
})
export const DesktopSessionErrorSchema = z.strictObject({ type: z.literal('error'), code: DesktopErrorCodeSchema, message: z.string().max(256) })
export const MeResponseSchema = z.looseObject({
  is_temp: z.boolean(), password_configured: z.boolean().optional(), auth_method: z.enum(['password', 'desktop']).optional(),
})
export type DesktopChallenge = z.infer<typeof DesktopChallengeSchema>
export type DesktopSessionRequest = z.infer<typeof DesktopSessionRequestSchema>
export type DesktopSessionResponse = z.infer<typeof DesktopSessionResponseSchema>
export type DesktopSessionError = z.infer<typeof DesktopSessionErrorSchema>
export type MeResponse = z.infer<typeof MeResponseSchema>
