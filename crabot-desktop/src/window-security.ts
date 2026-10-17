import type { WebContents, WebFrameMain } from 'electron'

export const APP_ORIGIN = 'app://crabot'
export function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'app:' && url.hostname === 'crabot' && !url.port && !url.username && !url.password
  } catch { return false }
}

export function isTrustedFrame(frame: WebFrameMain | null | undefined, expected: WebContents | undefined): boolean {
  try {
    if (!frame || !expected || expected.isDestroyed() || frame.parent || frame.origin !== APP_ORIGIN || !isAppUrl(frame.url)) return false
    const main = expected.mainFrame
    return frame.processId === main.processId && frame.routingId === main.routingId
  } catch { return false }
}

export function externalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
