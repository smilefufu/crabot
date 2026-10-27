import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { correlateHttpRequest } from './http-diagnostics.js'

describe('HTTP correlation', () => {
  it('validates and echoes IDs without recording URL, query, credentials or body', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), statusCode: 200 })
      const request = { headers: { 'x-crabot-request-id': 'req_safe', authorization: 'private-token' }, method: 'POST', url: '/api/chat?text=private-text', body: 'private-body' }
      correlateHttpRequest(request as unknown as IncomingMessage, response as unknown as ServerResponse)
      response.emit('finish')
      expect(response.setHeader).toHaveBeenCalledWith('X-Crabot-Request-Id', 'req_safe')
      const output = JSON.stringify(log.mock.calls)
      expect(output).toContain('req_safe')
      for (const secret of ['private-token', 'private-text', 'private-body', '/api/chat']) expect(output).not.toContain(secret)
      for (const invalid of ['../unsafe', 'x\ny', 'x'.repeat(129), ['two', 'headers']]) {
        response.setHeader.mockClear()
        correlateHttpRequest({ headers: { 'x-crabot-request-id': invalid } } as unknown as IncomingMessage, response as unknown as ServerResponse)
        expect(response.setHeader.mock.calls[0][1]).toMatch(/^[a-f0-9-]{36}$/)
      }
    } finally { log.mockRestore() }
  })
})
