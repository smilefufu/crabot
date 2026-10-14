export type ComputerUsePermissionStatus = 'granted' | 'missing' | 'unknown' | 'not_applicable'
export type ComputerUseCaptureStatus = 'verified' | 'failed' | 'unverified'
export type ComputerUseRuntimeState = 'uninitialized' | 'connecting' | 'ready' | 'quarantined'
export type ComputerUseSetupPhase = 'permissions' | 'capture' | 'connecting' | 'ready' | 'failed' | 'cancelled'

export interface ComputerUseRuntimeStatus {
  state: ComputerUseRuntimeState
  reason?: string
  checks?: Array<{ name: string; status: 'pass' | 'fail' | 'skip' }>
  capture?: { setup_id: string; status: ComputerUseCaptureStatus; verified_at?: string; reason?: string }
}
export interface ComputerUseSetupStatus {
  enabled: boolean
  standard: boolean
  host: { platform: string; hostname: string; session: 'active' | 'unavailable' | 'unknown' }
  permissions: { accessibility: ComputerUsePermissionStatus; screen_recording: ComputerUsePermissionStatus }
  capture: { status: ComputerUseCaptureStatus; verified_at?: string; reason?: string }
  runtime: ComputerUseRuntimeStatus
  setup?: { setup_id: string; phase: ComputerUseSetupPhase; expires_at: string; reason?: string }
  app_path?: string
  reason?: string
}
export interface ComputerUseSetupRequest {
  setup_id: string
  expires_at: string
}

/** Pure descriptor recognition; it grants no caller or process authority. */
export function isStandardComputerUse(config: { name: string; transport?: string; command?: string; args?: string[]; env?: Record<string, string> }): boolean {
  return config.name === 'computer-use' && (config.transport ?? 'stdio') === 'stdio' && config.command === 'node'
    && config.args?.length === 2 && config.args[1] === '--crabot-standard'
    && config.args[0].replace(/\\/g, '/').endsWith('/crabot-mcp-tools/dist/computer-use/main.js')
    && Object.keys(config.env ?? {}).length === 0
}
