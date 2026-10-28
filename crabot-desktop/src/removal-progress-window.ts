import { createOperationProgressWindow } from './operation-progress-window.js'
export function createRemovalProgressWindow(abort: AbortController) {
  return createOperationProgressWindow('removal', abort)
}
