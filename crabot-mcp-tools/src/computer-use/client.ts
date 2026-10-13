import { connect } from 'node:net'

export interface ComputerUseRequest { token: string; method: 'list' | 'call'; name?: string; args?: Record<string, unknown> }
export function requestComputerUse(endpoint: string, request: ComputerUseRequest, signal?: AbortSignal): Promise<any> {
  return new Promise((done, fail) => {
    const socket = connect(endpoint)
    const chunks: string[] = []
    let bytes = 0
    const timer = setTimeout(() => socket.destroy(new Error('COMPUTER_USE_BRIDGE_TIMEOUT')), 65_000)
    const abort = () => socket.destroy(new Error('COMPUTER_USE_CANCELLED_UNKNOWN'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => { chunks.push(chunk.toString()); bytes += Buffer.byteLength(chunk); if (bytes > 24 * 1024 * 1024) socket.destroy(new Error('COMPUTER_USE_BRIDGE_LIMIT')) })
    socket.on('error', fail)
    socket.on('close', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      try { const response = JSON.parse(chunks.join('')); if (response.error) fail(new Error(response.error)); else done(response.result) } catch (error) { fail(error) }
    })
  })
}
