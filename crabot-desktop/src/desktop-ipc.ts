import type { IpcMain, WebContents } from 'electron'
import { externalUrl, isTrustedFrame } from './window-security.js'
import type { DesktopController } from './controller.js'
import { DesktopDirectorySelectionSchema, WorkspaceIdSchema, z, type DesktopDiagnostics } from 'crabot-client'

export function registerDesktopIpc(options: { ipc: IpcMain; contents: () => WebContents | undefined; controller: DesktopController;
  quit: () => Promise<boolean>; openUpdateDialog: () => Promise<boolean>; openExternal: (url: string) => Promise<void>; revealData: () => Promise<boolean>;
  revealWorkspace: (workspaceId: string) => Promise<boolean>; selectWorkspace: () => Promise<string | null>;
  diagnostics: () => Promise<DesktopDiagnostics>; exportDiagnostics: (id: string) => Promise<boolean> }) {
  const channels: string[] = []
  function handle(channel: string, action: (argument: unknown, verify: () => void) => unknown, argumentAllowed = false) {
    channels.push(channel)
    options.ipc.handle(channel, (event, argument) => {
      const verify = () => { if (event.sender.id !== options.contents()?.id || !isTrustedFrame(event.senderFrame, options.contents())) throw new Error('Desktop request rejected') }
      verify()
      if (!argumentAllowed && argument !== undefined) throw new Error('Invalid desktop request')
      return action(argument, verify)
    })
  }
  handle('desktop:get-state', () => options.controller.host.snapshot())
  handle('desktop:start', () => options.controller.start())
  handle('desktop:stop', () => options.controller.stop())
  handle('desktop:reconnect', () => options.controller.reconnect())
  handle('desktop:quit', options.quit)
  handle('desktop:open-update', options.openUpdateDialog)
  handle('desktop:open-external', async value => { const url = externalUrl(value); if (!url) return false; await options.openExternal(url); return true }, true)
  handle('desktop:reveal-data', options.revealData)
  handle('desktop:reveal-workspace', value => options.revealWorkspace(WorkspaceIdSchema.parse(value)), true)
  handle('desktop:select-workspace-directory', async (_value, verify) => {
    const selected = DesktopDirectorySelectionSchema.parse(await options.selectWorkspace())
    verify()
    return selected
  })
  handle('desktop:diagnostics', options.diagnostics)
  handle('desktop:export-diagnostics', value => options.exportDiagnostics(z.uuid().parse(value)), true)
  return () => { channels.forEach(channel => options.ipc.removeHandler(channel)) }
}
