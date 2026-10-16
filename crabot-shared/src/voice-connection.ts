import type { VoiceConnectionConfig, VoiceSetupMetadata, VoiceTerminalEntry } from './voice.js'

export function parseVoiceConnection(raw: unknown): VoiceConnectionConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('语音连接设置无效')
  const v = raw as Record<string, unknown>
  if (Object.keys(v).some(k => k !== 'base_url' && k !== 'transport') || typeof v.base_url !== 'string' || v.base_url.length > 2048 || !['ws', 'wss'].includes(v.transport as string)) throw new Error('语音连接设置无效')
  const input = v.base_url.trim()
  if (input.includes('\\') || /(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f|$)/i.test(input)) throw new Error('后台地址路径无效')
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.port === '0' || url.username || url.password || url.search || url.hash || /^\[fe[89ab]/i.test(url.hostname) || /^169\.254\./.test(url.hostname)) throw new Error('请填写有效的 HTTP/HTTPS 后台地址')
  for (const segment of url.pathname.split('/')) {
    const decoded = decodeURIComponent(segment)
    if (['.', '..'].includes(decoded) || /[\/\\\u0000-\u001f]/.test(decoded)) throw new Error('后台地址路径无效')
  }
  return { base_url: url.toString().replace(/\/+$/, ''), transport: v.transport as 'ws' | 'wss' }
}

export function voiceTerminalEntry(connection: VoiceConnectionConfig, channelId: string, fingerprint?: string): VoiceTerminalEntry {
  const { base_url, transport } = parseVoiceConnection(connection)
  const url = new URL(base_url)
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  url.protocol = transport + ':'
  url.port = port
  url.pathname = url.pathname.replace(/\/+$/, '') + '/ws/voice/' + encodeURIComponent(channelId)
  if (fingerprint !== undefined && !/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('入口证书指纹无效')
  return { url: url.toString(), ...(transport === 'wss' && fingerprint ? { tls_fingerprint_sha256: fingerprint } : {}) }
}

export function voiceSetupStatus(metadata?: VoiceSetupMetadata): 'draft' | 'complete' {
  if (metadata === undefined) return 'complete'
  if (!metadata || !['draft', 'complete'].includes(metadata.status) || Object.keys(metadata).some(k => k !== 'status' && k !== 'connection')) throw new Error('语音创建状态无效')
  if (metadata.connection !== undefined) parseVoiceConnection(metadata.connection)
  return metadata.status
}
