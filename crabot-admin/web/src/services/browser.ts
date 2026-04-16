import { api } from './api'

interface BrowserConfig {
  profile_mode: string
  cdp_port: number
  is_running: boolean
}

interface BrowserStartResult {
  cdp_url: string
}

interface BrowserOkResult {
  ok: boolean
}

export const browserService = {
  getConfig: (): Promise<BrowserConfig> =>
    api.get<BrowserConfig>('/browser/config'),

  updateConfig: (config: { profile_mode: string }): Promise<BrowserOkResult> =>
    api.patch<BrowserOkResult>('/browser/config', config),

  start: (): Promise<BrowserStartResult> =>
    api.post<BrowserStartResult>('/browser/start'),

  stop: (): Promise<BrowserOkResult> =>
    api.post<BrowserOkResult>('/browser/stop'),
}
