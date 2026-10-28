import { createOperationProgressWindow } from './operation-progress-window.js'
export function createInstallationProgressWindow(abort: AbortController) {
  return createOperationProgressWindow('installation', abort)
}
