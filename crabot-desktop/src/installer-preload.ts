import { contextBridge, ipcRenderer } from 'electron'
import { z } from 'crabot-client'
import { InstallationProgressSchema, type InstallationProgress } from './installer-progress.js'
contextBridge.exposeInMainWorld('crabotInstall', Object.freeze({
  cancel: async () => z.boolean().parse(await ipcRenderer.invoke('installer:cancel')),
  subscribe: (callback: (state: InstallationProgress) => void) => {
    const receive = (_: unknown, value: unknown) => { const state = InstallationProgressSchema.safeParse(value); if (state.success) callback(state.data) }
    ipcRenderer.on('installer:progress', receive)
    return () => ipcRenderer.removeListener('installer:progress', receive)
  },
}))
