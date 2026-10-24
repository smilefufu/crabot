// Fresh-install completion only. Preparation and existing-data takeover remain
// separate. OS authorization is never evidence of a working Chromium sandbox.
export async function finishUbuntuInstallation(options: {
  signal: AbortSignal
  probe: () => Promise<void>
  authorizationNeeded: () => Promise<boolean>
  authorize: () => Promise<void>
  register: () => Promise<void>
  commit: () => Promise<unknown>
}): Promise<unknown> {
  await ensureUbuntuProgramsReady(options)
  options.signal.throwIfAborted()
  await options.register()
  // Registration may already be durable. Commit has its own lock/integrity
  // checks; cancellation is no longer offered between these two final steps.
  return options.commit()
}

// Readiness only: neither first-install registration nor update selection.
export async function ensureUbuntuProgramsReady(options: {
  signal: AbortSignal; probe: () => Promise<void>
  authorizationNeeded: () => Promise<boolean>; authorize: () => Promise<void>
}): Promise<void> {
  const { signal } = options
  signal.throwIfAborted()
  try { await options.probe() }
  catch (error) {
    signal.throwIfAborted()
    if (!await options.authorizationNeeded()) throw error
    await options.authorize()
    signal.throwIfAborted()
    await options.probe()
  }
  signal.throwIfAborted()
}


const probePhasePattern = 'arguments|profile|window|network|renderer|kernel|runtime|(?:chromium|headless)-(?:launch|network|kernel)|scrapling-(?:policy|fetch)'
const probeFailureLine = new RegExp('CRABOT_(?:GUI|BROWSER)_SANDBOX_PROBE_FAILED:(' + probePhasePattern + ')\\r?\\n')
const validProbePhase = new RegExp('^(?:' + probePhasePattern + ')$')
const failureCodes = new Set(['ENOSPC', 'CRABOT_UPDATE_SPACE', 'CRABOT_CORE_INTEGRITY', 'CRABOT_INSTALL_FILESYSTEM', 'CRABOT_INSTALL_SYSTEM_MODE',
  'CRABOT_DESKTOP_TAKEOVER_REQUIRED', 'CRABOT_INSTALL_REGISTRATION', 'CRABOT_INSTALL_PROGRAM_IDENTITY', 'CRABOT_INSTALL_GUI_SANDBOX',
  'CRABOT_INSTALL_BROWSER_SANDBOX', 'CRABOT_INSTALL_SYSTEM_AUTHORIZATION'])

export function probeFailurePhase(stderr: string): string | undefined {
  return probeFailureLine.exec(stderr)?.[1]
}
export function ubuntuInstallationFailure(error: unknown, cancelled: boolean): { code: string; phase?: string } {
  const value = error as { code?: unknown; phase?: unknown } | null | undefined
  let code = 'NOT_READY'
  if (cancelled) code = 'CANCELLED'
  else if (typeof value?.code === 'string' && failureCodes.has(value.code)) code = value.code
  const result: { code: string; phase?: string } = { code }
  if (typeof value?.phase === 'string' && validProbePhase.test(value.phase)) result.phase = value.phase
  return result
}
