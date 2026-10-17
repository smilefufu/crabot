import type { IpcMain, WebContents } from 'electron'
import { externalUrl, isTrustedFrame } from './window-security.js'
import type { DesktopController } from './controller.js'

export function registerDesktopIpc(options: { ipc: IpcMain; contents: () => WebContents | undefined; controller: DesktopController;
  quit: () => Promise<boolean>; openExternal: (url: string) => Promise<void>; revealData: () => Promise<boolean> }) {
  const channels: string[] = []
  function handle(channel: string, action: (argument?: unknown) => unknown, argumentAllowed = false) {
    channels.push(channel)
    options.ipc.handle(channel, (event, argument) => {
      if (event.sender.id !== options.contents()?.id || !isTrustedFrame(event.senderFrame, options.contents())) throw new Error('Desktop request rejected')
      if (!argumentAllowed && argument !== undefined) throw new Error('Invalid desktop request')
      return action(argument)
    })
  }
  handle('desktop:get-state', () => options.controller.host.snapshot())
  handle('desktop:start', () => options.controller.start())
  handle('desktop:stop', () => options.controller.stop())
  handle('desktop:reconnect', () => options.controller.reconnect())
  handle('desktop:quit', options.quit)
  handle('desktop:open-external', async value => { const url = externalUrl(value); if (!url) return false; await options.openExternal(url); return true }, true)
  handle('desktop:reveal-data', options.revealData)
  return () => { channels.forEach(channel => options.ipc.removeHandler(channel)) }
}
