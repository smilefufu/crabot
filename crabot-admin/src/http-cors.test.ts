import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import AdminModule from './index.js'

it('desktop cross-origin preflight admits existing API methods without authenticating or executing a write', async () => {
  const admin = Object.create(AdminModule.prototype) as any
  admin.adminConfig = { web_port: 0 }
  admin.verifyAuthenticatedToken = vi.fn(async () => { throw new Error('Preflight must not authenticate') })
  admin.handleUpdateFriendPermissionApi = vi.fn(async () => { throw new Error('Preflight must not write') })
  const server = createServer((request, response) => { void admin.handleWebRequest(request, response) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address() as { port: number }
  try {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/friends/fixture/permissions`, {
        method: 'OPTIONS', headers: { Origin: 'app://crabot', 'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'authorization,content-type,x-crabot-request-id' },
      })
      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Methods')?.split(',').map(value => value.trim())).toContain(method)
      expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('authorization')
    }
    expect(admin.verifyAuthenticatedToken).not.toHaveBeenCalled()
    expect(admin.handleUpdateFriendPermissionApi).not.toHaveBeenCalled()
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
