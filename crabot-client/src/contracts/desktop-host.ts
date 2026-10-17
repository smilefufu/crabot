import { z } from 'zod'
import { LoopbackAdminOriginSchema } from './desktop.js'

const Common = { app_version: z.string().min(1), platform: z.enum(['darwin', 'win32', 'linux']) }
export const DesktopHostStateSchema = z.discriminatedUnion('phase', [
  z.strictObject({ ...Common, phase: z.literal('ready'), instance_id: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.uuid(), admin_url: LoopbackAdminOriginSchema }),
  z.strictObject({ ...Common, phase: z.enum(['discovering', 'starting', 'stopping', 'authenticating', 'stopped', 'disconnected', 'migration_required', 'error']),
    code: z.string().max(128).optional(), message: z.string().max(512).optional() }),
])
export type DesktopHostState = z.infer<typeof DesktopHostStateSchema>

// Narrow host capabilities only. No token getter, business API, raw IPC or command/file proxy.
export interface DesktopBridge {
  getState(): Promise<DesktopHostState>
  onStateChanged(callback: (state: DesktopHostState) => void): () => void
  startService(): Promise<DesktopHostState>
  stopService(): Promise<DesktopHostState>
  reconnect(): Promise<DesktopHostState>
  quit(): Promise<boolean>
  openExternal(url: string): Promise<boolean>
  revealDataFolder(): Promise<boolean>
}
