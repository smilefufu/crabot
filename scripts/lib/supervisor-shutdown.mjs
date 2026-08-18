export const MM_SHUTDOWN_WINDOW_MS = 60_000
export const SUPERVISOR_FORCE_MARGIN_MS = 10_000
export const SUPERVISOR_FORCE_TIMEOUT_MS = MM_SHUTDOWN_WINDOW_MS + SUPERVISOR_FORCE_MARGIN_MS

export function createSupervisorShutdownController({ mm, cleanup, log }) {
  let forceTimer = null
  let finished = false

  return {
    handleSignal(signal) {
      if (finished || forceTimer !== null) return
      log(`[supervisor] received ${signal}, stopping MM\n`)
      if (mm.pid) {
        try { mm.kill('SIGTERM') } catch { /* MM already exited */ }
      }
      forceTimer = setTimeout(() => {
        if (mm.pid) {
          try { mm.kill('SIGKILL') } catch { /* MM already exited */ }
        }
        cleanup(1)
      }, SUPERVISOR_FORCE_TIMEOUT_MS)
      forceTimer.unref?.()
    },

    handleMmExit(exitCode) {
      if (finished) return
      finished = true
      if (forceTimer !== null) {
        clearTimeout(forceTimer)
        forceTimer = null
      }
      cleanup(exitCode)
    },
  }
}
