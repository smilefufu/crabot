// Fixed role entry: private admission, one recorded file operation, then descriptor release and exit.
import { enterWorkspaceFileHost } from './lib/workspace-file-host.mjs'
import { readWorkspaceRelocationFileActors } from './lib/workspace-relocation-intent.mjs'
import { journalFields as fields } from './lib/workspace-coordinator-journal.mjs'
import { sha256CanonicalJson as hash } from '../crabot-shared/dist/canonical-json.js'

let context, attemptHash
const controller = new AbortController()
const disconnected = () => controller.abort()
process.once('disconnect', disconnected)
try {
  context = await enterWorkspaceFileHost()
  const work = new Promise((resolve, reject) => {
    const clear = () => { process.off('message', receive); process.off('disconnect', closed) }
    const closed = () => { clear(); resolve(null) }
    const receive = message => {
      clear()
      try {
        const current = readWorkspaceRelocationFileActors(context.dataDir, context.id)
        if (!fields(message, ['kind', 'intent_id', 'attempt_sha256']) || message.kind !== 'workspace_file_prepare'
          || message.intent_id !== context.id || !current.file_attempt || current.file_ready || message.attempt_sha256 !== hash(current.file_attempt)) throw new Error('Invalid fixed file preparation')
        attemptHash = message.attempt_sha256; resolve(message)
      } catch (error) { reject(error) }
    }
    process.once('message', receive); process.once('disconnect', closed)
  })
  await new Promise((resolve, reject) => process.send(context.entered, error => error ? reject(error) : resolve()))
  if (await work) {
    const { runWorkspaceFilePreparation } = await import('./lib/workspace-file-driver.mjs')
    await runWorkspaceFilePreparation(context, controller.signal)
    await new Promise((resolve, reject) => process.send({ kind: 'workspace_file_prepared', intent_id: context.id, attempt_sha256: attemptHash }, error => error ? reject(error) : resolve()))
  }
} catch (error) {
  process.exitCode = 1
  if (process.connected && context && attemptHash) await new Promise(resolve => process.send({ kind: 'workspace_file_preparation_failed', intent_id: context.id,
    attempt_sha256: attemptHash, error_code: typeof error.code === 'string' ? error.code.slice(0, 128) : 'WORKSPACE_COPY_UNVERIFIED' }, () => resolve()))
} finally {
  process.off('disconnect', disconnected)
  if (process.connected) process.disconnect()
}
