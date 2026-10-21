// Neutral fixed copier only. The original file Host owns staging, authority and publication.
import native from './process-identity.cjs'

const failure = () => Object.assign(new Error('Windows 固定工作区复制未能核实，原目录与暂存保留。'), { code: 'WORKSPACE_COPY_UNVERIFIED' })
export async function copyWorkspaceTreePinned(source, tree, container, { journal, signal } = {}) {
  if (process.platform !== 'win32' || !journal || signal?.aborted) throw failure()
  let job, registered = false, completionAttempted = false
  const check = () => { if (signal?.aborted) throw failure() }
  const close = () => {
    if (!job) return
    const owned = job
    job = undefined // Unknown close is never resubmitted.
    native.closeWorkspaceCopyJob(owned)
  }
  try {
    job = native.createWorkspaceCopyJob(source, tree)
    const original = native.inspectWorkspaceCopyJob(job)
    if (original.state !== 'suspended' || original.exit_code !== null) throw failure()
    if ((await journal.register([{ role: 'copy', process: original.process }])).dispatch !== 'dispatch') throw failure()
    registered = true
    check()
    if ((await journal.permit()).dispatch !== 'dispatch') throw failure()
    check()
    const current = native.inspectWorkspaceCopyJob(job)
    if (current.state !== 'suspended' || !native.sameProcess(current.process, original.process)) throw failure()
    native.resumeWorkspaceCopyJob(job)
    const deadline = performance.now() + 20 * 60_000
    for (;;) {
      check()
      const state = native.inspectWorkspaceCopyJob(job)
      if (!native.sameProcess(state.process, original.process)) throw failure()
      if (state.state === 'exited') {
        if (!Number.isInteger(state.exit_code) || state.exit_code < 0 || state.exit_code > 7) throw failure()
        break
      }
      if (state.state !== 'running' || performance.now() >= deadline) throw failure()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    completionAttempted = true
    await journal.complete()
    check()
    native.copyPinnedWorkspaceMetadata(source, tree)
    check()
    // Includes child streams/files, the tree and its private container, in child-to-parent order.
    native.syncPinnedWorkspaceTree(container)
    check()
  } catch (error) {
    close()
    if (registered && !completionAttempted) {
      completionAttempted = true
      try { await journal.complete() } catch { /* Keep the original failure and maintenance on unknown confirmation. */ }
    }
    throw error
  } finally { close() }
}
