// Source-restoration namespace only; the shared transport does not choose an action.
import { releaseWorkspaceInterruptedProtection } from './workspace-interrupted-service-release.mjs'
export function releaseWorkspaceInterruptedSource(options) {
  return releaseWorkspaceInterruptedProtection(options, 'restore_source')
}
