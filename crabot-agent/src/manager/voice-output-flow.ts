import { setTimeout as delay } from 'node:timers/promises'
import type { VoiceOutputEvent, VoiceOutputResult, VoicePlaybackReceipt } from 'crabot-shared'

type Send = (event: VoiceOutputEvent) => Promise<VoiceOutputResult>
type Receipt = (id: string) => Promise<VoicePlaybackReceipt>

export async function appendVoiceText(send: Send, receipt: Receipt | undefined, id: string, sequence: number, text: string, signal?: AbortSignal): Promise<number> {
  const points = Array.from(text)
  for (let offset = 0; offset < points.length; offset += 120) {
    const fragment = points.slice(offset, offset + 120).join('')
    for (;;) {
      signal?.throwIfAborted()
      const result = await send({ type: 'reply_text', playback_id: id, sequence, text: fragment })
      if ('accepted' in result && result.accepted) break
      if (!('code' in result) || result.code !== 'VOICE_OUTPUT_BACKPRESSURE' || !receipt) throw new Error('Invalid voice text acceptance')
      if ((await receipt(id)).status !== 'active') throw new Error('Voice output is no longer active')
      await delay(500, undefined, { signal })
    }
    sequence++
  }
  return sequence
}

export async function finishVoicePlayback(send: Send, receipt: Receipt | undefined, id: string, signal?: AbortSignal): Promise<{ platform_message_id: string; sent_at: string; played_samples: number }> {
  let result = await send({ type: 'reply_end', playback_id: id })
  if ('accepted' in result) {
    if (!result.accepted || !receipt) throw new Error('Voice completion receipt is unavailable')
    for (;;) {
      signal?.throwIfAborted()
      const current = await receipt(id)
      if (current.playback_id !== id) throw new Error('Voice receipt identity differs')
      if (current.status === 'completed') { result = { platform_message_id: id, sent_at: current.sent_at!, played_samples: current.played_samples! }; break }
      if (current.status !== 'active') throw new Error('Voice completion is unknown or failed')
      await delay(500, undefined, { signal })
    }
  }
  if (!('platform_message_id' in result) || result.platform_message_id !== id || !Number.isSafeInteger(result.played_samples)
    || result.played_samples <= 0 || !Number.isFinite(Date.parse(result.sent_at))) throw new Error('Invalid voice completion receipt')
  return result
}
