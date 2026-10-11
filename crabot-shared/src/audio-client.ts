import { promises as fs } from 'node:fs'
import { WebSocket } from 'undici'
import type { AudioServiceConnection } from './voice.js'

export function pcm16Wave(pcm: Buffer, sampleRate = 16000): Buffer {
  if (!pcm.length || pcm.length % 2) throw new Error('Invalid PCM16')
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Validate a complete single RIFF file before playing any of its bytes. */
export function speechWaveToPcm(wave: Buffer): Buffer {
  if (wave.length < 44 || wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE' || wave.readUInt32LE(4) + 8 !== wave.length) throw new Error('Incomplete or invalid speech WAV')
  let format: { code: number; bits: number; alignment: number } | undefined
  let data: Buffer | undefined
  for (let offset = 12; offset < wave.length;) {
    if (offset + 8 > wave.length) throw new Error('Incomplete WAV chunk')
    const type = wave.toString('ascii', offset, offset + 4)
    const size = wave.readUInt32LE(offset + 4); const start = offset + 8
    if (start + size > wave.length) throw new Error('Incomplete WAV chunk')
    if (type === 'fmt ') {
      if (format || size < 16) throw new Error('Invalid WAV format')
      const code = wave.readUInt16LE(start); const channels = wave.readUInt16LE(start + 2)
      const rate = wave.readUInt32LE(start + 4); const alignment = wave.readUInt16LE(start + 12); const bits = wave.readUInt16LE(start + 14)
      if (channels !== 1 || rate !== 24000 || !((code === 1 && bits === 16) || (code === 3 && bits === 32)) || alignment !== bits / 8 || wave.readUInt32LE(start + 8) !== rate * alignment) throw new Error('Speech must be 24kHz mono PCM16 or FLOAT32 WAV')
      format = { code, bits, alignment }
    } else if (type === 'data') {
      if (data) throw new Error('Multiple WAV data chunks are unsupported')
      data = wave.subarray(start, start + size)
    }
    offset = start + size + (size % 2)
    if (offset > wave.length) throw new Error('Incomplete WAV padding')
  }
  if (!format || !data?.length || data.length % format.alignment || data.length / format.alignment > 480000) throw new Error('Invalid/empty speech or speech longer than 20 seconds')
  const pcm = Buffer.alloc(data.length / format.alignment * 2)
  let audible = false
  for (let i = 0; i < pcm.length / 2; i++) {
    const sample = format.code === 1 ? data.readInt16LE(i * 2) : data.readFloatLE(i * 4) * 32768
    if (!Number.isFinite(sample)) throw new Error('Non-finite speech sample')
    const value = Math.max(-32768, Math.min(32767, Math.round(sample)))
    audible ||= value !== 0
    pcm.writeInt16LE(value, i * 2)
  }
  if (!audible) throw new Error('Speech service returned only silence')
  return pcm
}

function headers(connection: AudioServiceConnection): Record<string, string> {
  return connection.api_key ? { Authorization: `Bearer ${connection.api_key}` } : {}
}
function endpoint(connection: AudioServiceConnection, route: string): string {
  const base = connection.endpoint.replace(/\/$/, '')
  return base.endsWith('/v1') ? base + route : base + '/v1' + route
}
async function boundedBody(response: Response, max: number): Promise<Buffer> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Audio service HTTP ${response.status}`) }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []; let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > max) { await reader.cancel(); throw new Error('Audio service response exceeds budget') }
      chunks.push(Buffer.from(chunk.value))
    }
    return Buffer.concat(chunks)
  } finally { for (const chunk of chunks) chunk.fill(0); reader.releaseLock() }
}

export async function transcribeAudio(connection: AudioServiceConnection, pcm: Buffer, signal: AbortSignal): Promise<string> {
  if (!pcm.length || pcm.length % 2 || pcm.length > 480000) throw new Error('Invalid finite ASR input')
  if (connection.format === 'sherpa-offline-ws') {
    return new Promise<string>((resolve, reject) => {
      signal.throwIfAborted()
      const ws = new WebSocket(connection.endpoint, { headers: headers(connection) })
      let settled = false
      let floatAudio: Buffer | undefined
      const finish = (text?: string, error?: Error): void => {
        if (settled) return
        settled = true; signal.removeEventListener('abort', abort)
        try { if (ws.readyState === WebSocket.OPEN && text) ws.send('Done'); ws.close() } catch { /* already failed/closed */ }
        floatAudio?.fill(0); floatAudio = undefined
        if (error) reject(error); else resolve(text!)
      }
      const abort = () => finish(undefined, new Error('ASR cancelled or timed out'))
      signal.addEventListener('abort', abort, { once: true })
      ws.addEventListener('error', () => finish(undefined, new Error('ASR websocket failed')))
      ws.addEventListener('close', () => finish(undefined, new Error('ASR websocket closed before a result')))
      ws.addEventListener('open', () => {
        if (settled) { ws.close(); return }
        try {
          floatAudio = Buffer.alloc(pcm.length * 2)
          for (let i = 0; i < pcm.length / 2; i++) floatAudio.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, i * 4)
          const header = Buffer.alloc(8); header.writeInt32LE(16000); header.writeInt32LE(floatAudio.length, 4)
          ws.send(header)
          for (let offset = 0; offset < floatAudio.length; offset += 64000) ws.send(floatAudio.subarray(offset, offset + 64000))
        } catch { finish(undefined, new Error('ASR websocket send failed')) }
      })
      ws.addEventListener('message', event => {
        if (typeof event.data !== 'string' || event.data.length > 8000 || !event.data.trim() || event.data === 'EMPTY') finish(undefined, new Error('ASR returned no usable text'))
        else finish(event.data.trim())
      })
    })
  }
  if (connection.format !== 'openai-audio') throw new Error('Selected service does not support ASR')
  const form = new FormData()
  form.set('model', connection.model_id); form.set('response_format', 'json')
  if (connection.language) form.set('language', connection.language)
  form.set('file', new Blob([Uint8Array.from(pcm16Wave(pcm))], { type: 'audio/wav' }), 'turn.wav')
  const response = await fetch(endpoint(connection, '/audio/transcriptions'), { method: 'POST', headers: headers(connection), body: form, signal, redirect: 'error' })
  const result = JSON.parse((await boundedBody(response, 65536)).toString('utf8')) as { text?: unknown }
  if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 8000) throw new Error('ASR returned no usable text')
  return result.text.trim()
}

export async function synthesizeAudio(connection: AudioServiceConnection, text: string, signal: AbortSignal): Promise<Buffer> {
  if (!text.trim() || Array.from(text).length > 120) throw new Error('Voice answer must be 1–120 characters')
  if (connection.format === 'sherpa-offline-ws') throw new Error('Selected service does not support TTS')
  if (!connection.voice) throw new Error('TTS voice is not configured')
  const body = { model: connection.model_id, voice: connection.voice, input: text, response_format: 'wav', ...(connection.format === 'mlx-audio-http' ? { lang_code: connection.language ?? 'z', stream: false } : {}) }
  const response = await fetch(endpoint(connection, '/audio/speech'), { method: 'POST', headers: { ...headers(connection), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' })
  const wave = await boundedBody(response, 4000000)
  try { return speechWaveToPcm(wave) }
  finally { wave.fill(0) }
}

export async function testAudioService(connection: AudioServiceConnection, capability: 'asr' | 'tts'): Promise<{ ok: true; capability: 'asr' | 'tts'; text?: string; sample_count?: number }> {
  if (capability === 'tts') {
    const pcm = await synthesizeAudio(connection, '你好，我是螃蟹。', AbortSignal.timeout(5000))
    const samples = pcm.length / 2; pcm.fill(0)
    return { ok: true, capability, sample_count: samples }
  }
  const wave = await fs.readFile(new URL('../assets/voice-service-test.wav', import.meta.url))
  // The checked-in fixture has FFmpeg metadata chunks; read its declared data, not a guessed offset.
  let offset = 12
  while (offset + 8 <= wave.length) {
    const size = wave.readUInt32LE(offset + 4)
    if (offset + 8 + size > wave.length) throw new Error('Invalid public ASR fixture')
    if (wave.toString('ascii', offset, offset + 4) === 'data') {
      const pcm = Buffer.from(wave.subarray(offset + 8, offset + 8 + size))
      try { return { ok: true, capability, text: await transcribeAudio(connection, pcm, AbortSignal.timeout(10000)) } }
      finally { pcm.fill(0); wave.fill(0) }
    }
    offset += 8 + size + size % 2
  }
  throw new Error('Public ASR fixture is missing audio')
}
