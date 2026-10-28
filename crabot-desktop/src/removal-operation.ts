// Fixed-host orchestration only. The lease retains all installation, process,
// proof and lock checks; the display receives no paths or file authority.
type Phase = 'preparing' | 'stopping' | 'removing' | 'completed'
type Lease = {
  current(): Promise<{ phase: Phase }>
  stop(): Promise<unknown>; retryStop(): Promise<unknown>
  exitSource(): Promise<unknown>; retrySourceExit(): Promise<unknown>
  removePrograms(signal: AbortSignal, beforeRemoving: () => void): Promise<{ retained: unknown[] }>
  retryRemovePrograms(signal: AbortSignal, beforeRemoving: () => void): Promise<{ retained: unknown[] }>
  cancel(): Promise<void>; close(): void
}
type Progress = { update(message: string, cancellable: boolean): void; close(): void | Promise<void> }
type Options = {
  lease: Lease
  openProgress(abort: AbortController): Promise<Progress>
  decide(failure: { canCancel: boolean; code: string }): Promise<'retry' | 'cancel' | 'close'>
  removeEntries(): Promise<void>; finish(): Promise<unknown>
}
const messages = ['正在正常停止共享服务…', '正在退出原应用并核验占用…', '正在核验并移除本安装程序，用户数据将保留…',
  '正在清理本安装的系统入口…', '正在确认卸载结果，用户数据仍保留…']
const cancellationAllowed = (phase?: Phase) => phase === 'preparing' || phase === 'stopping'
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'CRABOT_DESKTOP_REMOVAL'
}

export async function runRemovalOperation(options: Options): Promise<'completed' | 'cancelled' | 'retained'> {
  const { lease } = options
  let step = 0, attempted = false
  try {
    for (;;) {
      const abort = new AbortController()
      let progress: Progress | undefined, failure: unknown, cancellationAttempted = false
      try {
        progress = await options.openProgress(abort)
        for (; step < messages.length;) {
          const { phase } = await lease.current()
          if (phase === 'completed') step = 4
          if (abort.signal.aborted && cancellationAllowed(phase)) { cancellationAttempted = true; await lease.cancel(); return 'cancelled' }
          progress.update(messages[step], step < 3 && cancellationAllowed(phase))
          const retry = attempted
          if (step === 0) { attempted = true; await (retry ? lease.retryStop() : lease.stop()) }
          else if (step === 1) { attempted = true; await (retry ? lease.retrySourceExit() : lease.exitSource()) }
          else if (step === 2) {
            attempted = true
            const beforeRemoving = () => { abort.signal.throwIfAborted(); progress!.update(messages[step], false) }
            const result = await (retry ? lease.retryRemovePrograms(abort.signal, beforeRemoving) : lease.removePrograms(abort.signal, beforeRemoving))
            if (result.retained.length) throw Object.assign(new Error('仍有程序未移除，入口与用户数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' })
          } else if (step === 3) await options.removeEntries()
          else await options.finish()
          step++; attempted = false
        }
        return 'completed'
      } catch (error) {
        failure = error
        const stage = (error as { stage?: unknown } | null)?.stage
        console.error(JSON.stringify({ component: 'desktop-removal', step, code: errorCode(error),
          ...(typeof stage === 'string' && /^[a-z-]{1,80}$/.test(stage) ? { stage } : {}) }))
      }
      finally { await progress?.close() }
      // The old display and its signal are gone before a retry. A failed stage
      // stays current; successful stop/exit/removal is never replayed by this UI.
      for (;;) {
        let phase: Phase | undefined
        try { phase = (await lease.current()).phase } catch { /* No cancellation authority without a current job. */ }
        const canCancel = cancellationAllowed(phase)
        if (!cancellationAttempted && abort.signal.aborted && canCancel) {
          cancellationAttempted = true
          try { await lease.cancel(); return 'cancelled' }
          catch (error) { failure = error }
        }
        const decision = await options.decide({ canCancel, code: errorCode(failure) })
        if (decision === 'retry') break
        if (decision !== 'cancel' || !canCancel) return 'retained'
        try { await lease.cancel(); return 'cancelled' }
        catch (error) { failure = error }
      }
    }
  } finally { lease.close() }
}
