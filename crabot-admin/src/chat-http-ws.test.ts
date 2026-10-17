import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import AdminModule from './index.js'
import { ChatManager } from './chat-manager.js'
import { MediaStore } from './media-store.js'
import { HttpClient, ChatClient, createChatRequest } from 'crabot-client'

describe('real loopback HTTP and legacy WS use the same chat admission', () => {
  let directory: string, manager: ChatManager, server: Server, endpoint: string
  let rpc: ReturnType<typeof vi.fn>
  let sessionValid: boolean
  const sockets: WebSocket[] = []
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'crabot-chat-transport-'))
    const media = new MediaStore(directory); await media.init()
    rpc = vi.fn(async () => ({}))
    sessionValid = true
    manager = new ChatManager(directory, { call: rpc, callSensitive: rpc } as never, async () => 12345, 'fixture-secret', async token => sessionValid && token === 'fixture-human' ? { sub: 'admin' } : null, media)
    await manager.loadData()
    const handler = (AdminModule.prototype as any).handlePostChatMessageApi
    server = createServer((request, response) => {
      // Human authentication is a fixture here; full JWT/desktop auth is verified separately.
      if (request.headers.authorization !== 'Bearer fixture-human') { response.writeHead(401).end(); return }
      if (request.method === 'POST' && request.url === '/api/chat/messages') {
        void handler.call({ chatManager: manager }, request, response)
      } else { response.writeHead(404).end() }
    })
    server.on('upgrade', (request, socket, head) => { void manager.handleUpgrade(request, socket as never, head) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  })
  afterEach(async () => {
    sockets.splice(0).forEach(socket => socket.terminate())
    manager.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await vi.waitFor(async () => expect(await readdir(path.join(directory, 'chat-inbound-dispatch-journal')).catch(() => [])).toHaveLength(0))
    await rm(directory, { recursive: true, force: true })
  })
  const client = () => new ChatClient(new HttpClient({ endpoint, token: () => 'fixture-human' }))

  it('HTTP preserves exact whitespace and sends the same Manager/session, human source and assertion', async () => {
    const request = createChatRequest('  hello\n世界  ', [], 'req-exact')
    const first = await client().send(request)
    expect(first.message.content.text).toBe(request.text)
    const retry = await client().send(request)
    expect(retry.message.message_id).toBe(first.message.message_id)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
    const [, method, params, source] = rpc.mock.calls[0] as unknown as [number, string, any, string]
    expect(method).toBe('process_message'); expect(source).toBe('admin-web')
    expect(params.source_type).toBe('admin_chat')
    expect(params.message.session).toEqual({ session_id: 'admin-chat', channel_id: 'admin-web', type: 'private' })
    expect(params.message.sender.friend_id).toBe('master')
    expect(params.message.content.text).toBe(request.text)
    expect(params.admin_chat_assertion).toEqual(expect.any(String))
    expect(manager.getMessages(100)).toHaveLength(1)
  })

  it('legacy WS followed by an identical HTTP retry creates one message and one dispatch', async () => {
    const socket = new WebSocket(endpoint.replace('http:', 'ws:').replace(/\/api$/, '') + '/ws/chat?token=fixture-human')
    sockets.push(socket); await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'chat_message', request_id: 'req-shared', content: ' same\ntext\rline ' }))
    await vi.waitFor(() => expect(manager.getMessages(10)).toHaveLength(1))
    const firstId = manager.getMessages(10)[0].message_id
    const retry = await client().send(createChatRequest(' same\ntext\rline ', [], 'req-shared'))
    expect(retry.message.message_id).toBe(firstId)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
    expect(manager.getMessages(10)).toHaveLength(1)
  })

  it('WS accepts a header without a token URL, and an invalid header never falls back to query authentication', async () => {
    const base = endpoint.replace('http:', 'ws:').replace(/\/api$/, '') + '/ws/chat'
    const socket = new WebSocket(base, { headers: { Authorization: 'Bearer fixture-human' } })
    sockets.push(socket); await once(socket, 'open')
    const rejected = new WebSocket(base + '?token=fixture-human', { headers: { Authorization: 'Bearer invalid' } })
    sockets.push(rejected)
    rejected.on('error', () => {})
    const [request, response] = await once(rejected, 'unexpected-response')
    expect(response.statusCode).toBe(401)
    response.resume(); request.destroy()
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each(['inbound', 'outbound'])('an established WS rejects %s after its session is revoked', async direction => {
    const socket = new WebSocket(endpoint.replace('http:', 'ws:').replace(/\/api$/, '') + '/ws/chat', {
      headers: { Authorization: 'Bearer fixture-human' },
    })
    sockets.push(socket); await once(socket, 'open')
    const messages: unknown[] = []
    socket.on('message', message => messages.push(message))
    sessionValid = false
    if (direction === 'inbound') socket.send(JSON.stringify({ type: 'chat_message', request_id: 'revoked', content: 'must not dispatch' }))
    else (manager as any).pushToClient({ type: 'chat_error', error: 'private event' })
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED), { timeout: 1000 })
    expect(messages).toEqual([])
    expect(manager.getMessages(10)).toHaveLength(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('same ID with changed text or attachment order is HTTP 409 with no extra visible message/media', async () => {
    const files = [new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.txt', { type: 'text/plain' })]
    await client().send(createChatRequest('attachments', files, 'req-conflict'))
    const before = await readdir(path.join(directory, 'media-store'))
    await expect(client().send(createChatRequest('different', files, 'req-conflict'))).rejects.toMatchObject({ status: 409, kind: 'conflict' })
    await expect(client().send(createChatRequest('attachments', [...files].reverse(), 'req-conflict'))).rejects.toMatchObject({ status: 409 })
    expect(manager.getMessages(100)).toHaveLength(1)
    expect(await readdir(path.join(directory, 'media-store'))).toEqual(before)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
  })

  it('multipart metadata must be strings and unauthorized requests have no admission effects', async () => {
    const body = new FormData(); body.append('request_id', 'req-malformed'); body.append('text', new File(['wrong'], 'wrong.txt'))
    const response = await fetch(endpoint + '/chat/messages', { method: 'POST', headers: { Authorization: 'Bearer fixture-human' }, body })
    expect(response.status).toBe(400)
    const denied = await fetch(endpoint + '/chat/messages', { method: 'POST', body })
    expect(denied.status).toBe(401)
    expect(manager.getMessages(100)).toHaveLength(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('new text_json is optional for old callers, but malformed/conflicting encodings never write state', async () => {
    for (const text_json of ['{broken', '123', '"different"', '"\\ud800"']) {
      const body = new FormData(); body.append('request_id', 'bad-encoding'); body.append('text', 'original'); body.append('text_json', text_json)
      const response = await fetch(endpoint + '/chat/messages', { method: 'POST', headers: { Authorization: 'Bearer fixture-human' }, body })
      expect(response.status).toBe(400)
    }
    expect(manager.getMessages(10)).toHaveLength(0)
    const body = new FormData(); body.append('request_id', 'legacy-http'); body.append('text', ' old caller ')
    const response = await fetch(endpoint + '/chat/messages', { method: 'POST', headers: { Authorization: 'Bearer fixture-human' }, body })
    expect(response.status).toBe(200)
    expect((await response.json()).message.content.text).toBe(' old caller ')
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
  })
})
