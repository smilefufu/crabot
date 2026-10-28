import type { Session, WebContents } from 'electron'
import { sameHostContext, type HostContext, type SessionHost } from './session-host.js'

export function artifactUrl(value: string, context: HostContext | null): string | null {
  if (!context) return null
  try {
    const url = new URL(value)
    if (url.origin !== new URL(context.admin_url).origin && !(url.protocol === 'app:' && url.host === 'crabot')) return null
    if (url.username || url.password || !/^\/api\/media\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(url.pathname)) return null
    return new URL(url.pathname, context.admin_url).href
  } catch { return null }
}

// This session belongs to one unprivileged artifact window. Authentication is a
// single explicit navigation/download, never a standing grant to its renderer.
export function attachArtifactNetwork(session: Session, host: SessionHost, contents: () => WebContents | undefined, target: string, scope: HostContext) {
  let armed: 'preview' | 'download' | undefined, requestId: number | undefined, closed = false
  const current = () => !closed && !!host.context() && sameHostContext(scope, host.context()!)
  const arm = (mode: 'preview' | 'download') => {
    if (!current() || armed || requestId !== undefined) return false
    armed = mode; return true
  }
  session.webRequest.onBeforeRequest((details, callback) => {
    if (details.id === requestId) {
      callback({ cancel: details.url !== target || !current() }); return
    }
    if (armed && details.webContentsId === contents()?.id && details.url === target && details.method === 'GET'
      && (armed === 'download' || details.resourceType === 'mainFrame')) {
      armed = undefined; requestId = details.id
      callback({ cancel: !current() }); return
    }
    callback({ cancel: details.resourceType === 'mainFrame' })
  })
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const key of Object.keys(headers)) if (/^(authorization|cookie)$/i.test(key)) delete headers[key]
    if (details.id !== requestId) { callback({ requestHeaders: headers }); return }
    if (details.url !== target || !current()) { callback({ cancel: true }); return }
    void host.credential().then(credential => {
      if (!credential || !current() || !sameHostContext(scope, credential)) { callback({ cancel: true }); return }
      headers.Authorization = 'Bearer ' + credential.token
      callback({ requestHeaders: headers })
    }, () => callback({ cancel: true }))
  })
  session.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    if (details.resourceType === 'mainFrame') {
      for (const key of Object.keys(headers)) if (/^content-security-policy(?:-report-only)?$/i.test(key)) delete headers[key]
      headers['Content-Security-Policy'] = ["sandbox allow-scripts; default-src 'none'; script-src https: 'unsafe-inline' 'unsafe-eval'; style-src https: 'unsafe-inline'; img-src https: data: blob:; font-src https: data:; connect-src https: wss:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"]
      headers['Referrer-Policy'] = ['no-referrer']
    }
    callback({ responseHeaders: headers })
  })
  const settled = (details: { id: number }) => { if (details.id === requestId) requestId = undefined }
  session.webRequest.onCompleted(settled)
  session.webRequest.onErrorOccurred(settled)
  return { arm, close: () => {
    closed = true; armed = undefined; requestId = undefined
    session.webRequest.onBeforeRequest(null); session.webRequest.onBeforeSendHeaders(null)
    session.webRequest.onHeadersReceived(null); session.webRequest.onCompleted(null); session.webRequest.onErrorOccurred(null)
  } }
}
