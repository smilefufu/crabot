import type { Session, WebContents, OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails } from 'electron'
import { sameHostContext, type SessionHost, type HostContext } from './session-host.js'
import { APP_ORIGIN, isTrustedFrame } from './window-security.js'

type Scope = HostContext
type Request = OnBeforeRequestListenerDetails | OnBeforeSendHeadersListenerDetails
function origin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol === 'wss:') url.protocol = 'https:'
    return url.origin
  } catch { return null }
}

// HTTP/WS go directly to Admin. Only credential injection lives here, bound to the
// request's original frame and generation so a delayed request cannot acquire a new token.
export function attachDesktopNetwork(session: Session, host: SessionHost, contents: () => WebContents | undefined): () => void {
  const requests = new Map<number, { at: number; scope: Scope | null }>()
  const trusted = (details: Request) => details.webContentsId === contents()?.id && details.initiatorOrigin === APP_ORIGIN
    && isTrustedFrame(details.frame, contents())
  session.webRequest.onBeforeRequest((details, callback) => {
    const now = Date.now()
    for (const [id, item] of requests) if (now - item.at > 5 * 60_000) requests.delete(id)
    if (!requests.has(details.id)) {
      const scope = host.context()
      if (requests.size >= 2048) { callback({ cancel: true }); return }
      requests.set(details.id, { at: now, scope: scope && trusted(details) && origin(details.url) === origin(scope.admin_url) ? scope : null })
    }
    callback({})
  })
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key]
    const original = requests.get(details.id)?.scope
    const current = host.context()
    // Preflight is public and carries no token; external requests receive no Admin credential.
    if (details.method === 'OPTIONS' || !current || origin(details.url) !== origin(current.admin_url)) { callback({ requestHeaders: headers }); return }
    if (!original || !sameHostContext(original, current) || !trusted(details)) { callback({ cancel: true }); return }
    void host.credential().then(credential => {
      if (!credential || !sameHostContext(original, credential) || !trusted(details)) { callback({ cancel: true }); return }
      headers.Authorization = 'Bearer ' + credential.token
      callback({ requestHeaders: headers })
    }, () => callback({ cancel: true }))
  })
  session.webRequest.onCompleted(details => {
    const request = requests.get(details.id); requests.delete(details.id)
    if (details.statusCode === 401 && request?.scope && host.context() && sameHostContext(request.scope, host.context()!)) void host.reconnect()
  })
  session.webRequest.onErrorOccurred(details => { requests.delete(details.id) })
  return () => {
    requests.clear(); session.webRequest.onBeforeRequest(null); session.webRequest.onBeforeSendHeaders(null)
    session.webRequest.onCompleted(null); session.webRequest.onErrorOccurred(null)
  }
}
