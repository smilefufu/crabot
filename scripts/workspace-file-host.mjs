// Fixed role entry. No file driver or business graph is loaded before independent identity/permission checks.
import { enterWorkspaceFileHost } from './lib/workspace-file-host.mjs'

try {
  const context = await enterWorkspaceFileHost()
  await new Promise((resolve, reject) => process.send(context.entered, error => error ? reject(error) : resolve()))
  // The current prepared host holds no workspace descriptors and performs no file effects.
  // A fixed file driver will consume the same immutable context in the next implementation step.
  process.once('disconnect', () => { process.exitCode = 0 })
} catch {
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
