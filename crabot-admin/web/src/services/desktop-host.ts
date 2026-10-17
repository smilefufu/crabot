import { useSyncExternalStore } from 'react'
import { ClientError, DesktopHostStateSchema, type DesktopBridge, type DesktopHostState } from 'crabot-client'
import { setServerScope } from './server-state'

declare global { interface Window { crabotDesktop?: DesktopBridge } }
export const desktopBridge = window.crabotDesktop
export const isDesktop = !!desktopBridge || window.location.protocol === 'app:'
let state: DesktopHostState | undefined
let lifetime = new AbortController(), revision = 0
const listeners = new Set<() => void>()
function receive(value: unknown) {
  const parsed = DesktopHostStateSchema.safeParse(value)
  if (!parsed.success) return
  const next = parsed.data
  const previousKey = state?.phase === 'ready' ? `${state.instance_id}/${state.generation}` : null
  const nextKey = next.phase === 'ready' ? `${next.instance_id}/${next.generation}` : null
  if (previousKey !== nextKey) {
    lifetime.abort(); lifetime = new AbortController(); revision++
    if (nextKey) setServerScope(`desktop/${nextKey}/${revision}`)
  }
  state = next
  listeners.forEach(listener => listener())
}
if (desktopBridge) {
  let events = 0
  desktopBridge.onStateChanged(value => { events++; receive(value) })
  // Subscribe first; an older initial snapshot cannot overwrite a newer event.
  void desktopBridge.getState().then(value => { if (!events) receive(value) }).catch(() => {})
}
export const getDesktopState = () => state
export function useDesktopState() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, getDesktopState)
}
export function desktopConnection() {
  if (state?.phase !== 'ready') throw new ClientError('unreachable', '本机服务尚未连接')
  return { origin: state.admin_url, signal: lifetime.signal }
}
export function adminUrl(relative: string): string {
  if (!relative.startsWith('/api/') || relative.startsWith('//') || /[\\\r\n#]/.test(relative)) throw new Error('Invalid Admin resource path')
  return new URL(relative, isDesktop ? desktopConnection().origin : window.location.origin).href
}
