import { contextBridge, ipcRenderer } from 'electron'
import { DesktopHostStateSchema, z, type DesktopBridge } from 'crabot-client'

const stateCall = async (channel: string) => DesktopHostStateSchema.parse(await ipcRenderer.invoke(channel))
const booleanCall = async (channel: string, value?: unknown) => z.boolean().parse(await ipcRenderer.invoke(channel, value))

const bridge: DesktopBridge = {
  getState: () => stateCall('desktop:get-state'),
  onStateChanged: callback => {
    const receive = (_event: unknown, value: unknown) => {
      const result = DesktopHostStateSchema.safeParse(value)
      if (result.success) callback(result.data)
    }
    ipcRenderer.on('desktop:state', receive)
    return () => { ipcRenderer.removeListener('desktop:state', receive) }
  },
  startService: () => stateCall('desktop:start'),
  stopService: () => stateCall('desktop:stop'),
  reconnect: () => stateCall('desktop:reconnect'),
  quit: () => booleanCall('desktop:quit'),
  openExternal: value => booleanCall('desktop:open-external', z.string().max(4096).parse(value)),
  revealDataFolder: () => booleanCall('desktop:reveal-data'),
}
contextBridge.exposeInMainWorld('crabotDesktop', Object.freeze(bridge))
