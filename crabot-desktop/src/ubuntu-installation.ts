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
  await options.register()
  // Registration may already be durable. Commit has its own lock/integrity
  // checks; cancellation is no longer offered between these two final steps.
  return options.commit()
}
