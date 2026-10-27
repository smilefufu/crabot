import { z } from 'zod'
import { LoopbackAdminOriginSchema } from './desktop.js'

const Common = { app_version: z.string().min(1), platform: z.enum(['darwin', 'win32', 'linux']) }
export const DesktopPhaseSchema = z.enum(['ready', 'discovering', 'starting', 'stopping', 'authenticating', 'stopped', 'disconnected', 'migration_required', 'error'])
export const DesktopHostStateSchema = z.discriminatedUnion('phase', [
  z.strictObject({ ...Common, phase: z.literal('ready'), instance_id: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.uuid(), admin_url: LoopbackAdminOriginSchema }),
  z.strictObject({ ...Common, phase: DesktopPhaseSchema.exclude(['ready']),
    code: z.string().max(128).optional(), message: z.string().max(512).optional() }),
])
export type DesktopHostState = z.infer<typeof DesktopHostStateSchema>
const ResourceStatus = z.enum(['entry_checked', 'unavailable'])
export const DesktopDiagnosticsSchema = z.strictObject({
  schema_version: z.literal(1), report_id: z.uuid(), created_at: z.iso.datetime(),
  system: z.strictObject({ platform: Common.platform, arch: z.string().max(64), os_release: z.string().max(128) }),
  state: DesktopHostStateSchema,
  runtime: z.strictObject({ status: ResourceStatus, versions: z.record(z.string().max(64), z.string().max(64)) }),
  resources: z.array(z.strictObject({ name: z.enum(['browser', 'computer_use', 'native_helper']), status: ResourceStatus })).max(3),
  recent: z.array(z.strictObject({ at: z.iso.datetime(), phase: DesktopPhaseSchema, code: z.string().max(128).optional() })).max(40),
})
export type DesktopDiagnostics = z.infer<typeof DesktopDiagnosticsSchema>
export const DesktopDirectorySelectionSchema = z.string().min(1).max(32768).refine(value => !value.includes('\0') && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)).nullable()

// Narrow host capabilities only. No token getter, business API, raw IPC or command/file proxy.
export interface DesktopBridge {
  getState(): Promise<DesktopHostState>
  onStateChanged(callback: (state: DesktopHostState) => void): () => void
  startService(): Promise<DesktopHostState>
  stopService(): Promise<DesktopHostState>
  reconnect(): Promise<DesktopHostState>
  quit(): Promise<boolean>
  openUpdateDialog(): Promise<boolean>
  openExternal(url: string): Promise<boolean>
  revealDataFolder(): Promise<boolean>
  revealWorkspaceFolder(workspace_id: string): Promise<boolean>
  selectWorkspaceDirectory(): Promise<string | null>
  getDiagnostics(): Promise<DesktopDiagnostics>
  exportDiagnostics(report_id: string): Promise<boolean>
}
