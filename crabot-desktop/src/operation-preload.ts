import { contextBridge, ipcRenderer } from 'electron'
import { z } from 'crabot-client'
import { OperationProgressSchema, type OperationProgress } from './operation-progress.js'
export function exposeOperationProgress(kind: 'installation' | 'removal') {
  if (kind !== 'installation' && kind !== 'removal') throw new Error('Unknown progress operation')
  const prefix = kind === 'removal' ? 'removal' : 'installer'
  contextBridge.exposeInMainWorld(kind === 'removal' ? 'crabotRemove' : 'crabotInstall', Object.freeze({
    cancel: async () => z.boolean().parse(await ipcRenderer.invoke(prefix + ':cancel')),
    subscribe: (callback: (state: OperationProgress) => void) => {
      const receive = (_: unknown, value: unknown) => { const state = OperationProgressSchema.safeParse(value); if (state.success) callback(state.data) }
      ipcRenderer.on(prefix + ':progress', receive)
      return () => ipcRenderer.removeListener(prefix + ':progress', receive)
    },
  }))
}
