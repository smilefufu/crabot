import fs from 'node:fs'
import path from 'node:path'
import type { VoiceOutputParams, VoiceOutputResult } from 'crabot-shared'
import type { VoiceDeliveryRecord, VoiceOutputPort } from './voice-output.js'

export function voiceOutputPort(directory: string, isVoice: () => boolean,
  send: (params: VoiceOutputParams) => Promise<VoiceOutputResult>): VoiceOutputPort {
  let recent: VoiceDeliveryRecord[] | undefined
  const records = (): VoiceDeliveryRecord[] => {
    if (!recent) {
      recent = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
        .map(name => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs }))
        .sort((a, b) => a.time - b.time).slice(-3)
        .map(({ name }) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as VoiceDeliveryRecord) : []
      for (const record of recent) if (record.status === 'prepared' || record.status === 'streaming') record.status = 'unknown'
    }
    return recent
  }
  return { isVoice, send, records, save(record) {
    const cache = records().filter(item => item.playback_id !== record.playback_id)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const filename = path.join(directory, record.playback_id + '.json'), temp = filename + '.tmp'
    try { fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); fs.renameSync(temp, filename) }
    finally { fs.rmSync(temp, { force: true }) }
    recent = [...cache, structuredClone(record)].slice(-3)
  } }
}
