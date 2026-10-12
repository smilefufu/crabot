import { connect } from 'node:net'

export interface ComputerUseRequest { token: string; method: 'list' | 'call'; name?: string; args?: Record<string, unknown> }
export function requestComputerUse(endpoint: string, request: ComputerUseRequest): Promise<any> {
  return new Promise((done, fail) => {
    const socket = connect(endpoint)
    let data = ''
    const timer = setTimeout(() => socket.destroy(new Error('COMPUTER_USE_BRIDGE_TIMEOUT')), 65_000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => { data += chunk; if (Buffer.byteLength(data) > 24 * 1024 * 1024) socket.destroy(new Error('COMPUTER_USE_BRIDGE_LIMIT')) })
    socket.on('error', fail)
    socket.on('close', () => {
      clearTimeout(timer)
      try { const response = JSON.parse(data); if (response.error) fail(new Error(response.error)); else done(response.result) } catch (error) { fail(error) }
    })
  })
}
