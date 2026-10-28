import { createHash } from 'node:crypto'
// Drain an independent audit branch to EOF even when the adapter stops at an SSE error.
export function observeResponse(response, onEvent = () => {}, streaming = true) {
  const [client, audit] = response.body.tee()
  const receipt = (async () => {
    const result = { httpStatus: response.status, eof: false, done: false, bytes: 0 }
    const hash = createHash('sha256'), decoder = new TextDecoder()
    let pending = '', bodyText = ''
    const event = value => {
      if (value.usage) result.usage = value.usage
      if (value.error) result.error = value.error
      onEvent(value)
    }
    const line = raw => {
      if (!raw.startsWith('data:')) return
      const data = raw.slice(5).trim()
      if (data === '[DONE]') { result.done = true; return }
      let value; try { value = JSON.parse(data) } catch { return }
      event(value)
    }
    try {
      for await (const chunk of audit) {
        hash.update(chunk); result.bytes += chunk.byteLength
        const text = decoder.decode(chunk, { stream: true })
        if (!response.ok || !streaming) { bodyText += text; continue }
        pending += text
        const lines = pending.split('\n'); pending = lines.pop()
        for (const raw of lines) line(raw)
      }
      const tail = decoder.decode()
      if (!response.ok || !streaming) {
        result.bodyText = bodyText + tail
        try { event(JSON.parse(result.bodyText)) } catch {}
      } else line(pending + tail)
      result.eof = true
    } catch (error) { result.transportError = String(error) }
    result.sha256 = hash.digest('hex')
    return result
  })()
  return { response: new Response(client, { status: response.status, statusText: response.statusText, headers: response.headers }), receipt }
}
