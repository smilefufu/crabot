import { expect, it } from 'vitest'
import { ExecutionAdmissions } from '../../src/core/execution-admissions.js'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
it('registers admission before an action can synchronously request quiescence', async () => {
  const admissions = new ExecutionAdmissions(), finish = deferred()
  let drained = false, drain!: Promise<void>
  const operation = admissions.run(async () => {
    drain = admissions.closeAndDrain().then(() => { drained = true })
    await finish.promise
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  finish.resolve(); await operation; await drain
})
it('also awaits late cleanup registered while an admitted operation is draining', async () => {
  const admissions = new ExecutionAdmissions(), action = deferred(), cleanup = deferred()
  const operation = admissions.run(async () => { await action.promise; admissions.trackCleanup(cleanup.promise) })
  let drained = false
  const drain = admissions.closeAndDrain().then(() => { drained = true })
  action.resolve(); await operation; await Promise.resolve()
  expect(drained).toBe(false)
  cleanup.resolve(); await drain
  await expect(admissions.run(async () => {})).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
})
