import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { SlackChannel } from '../src/slack-channel.js'
import { SlackClient } from '../src/slack-client.js'
import { mediaServer } from './fixtures/https-media.js'

it('preserves reaction targets through the real SDK HTTPS boundary and recovers from platform failures', async () => {
  const requests: Array<Record<string, string>> = []
  let failure = ''
  const fixture = await mediaServer('custom', async (req, res) => {
    const pieces: Buffer[] = []
    for await (const piece of req) pieces.push(piece)
    const params = new URLSearchParams(Buffer.concat(pieces).toString())
    const send = (body: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
    if (req.url === '/api/conversations.info') return send({ ok: true, channel: { id: params.get('channel'), is_member: true, name: 'room' } })
    if (req.url === '/api/users.info') return send({ ok: true, user: { id: 'U1', name: 'Alice' } })
    if (req.url !== '/api/reactions.add') { res.writeHead(404); res.end(); return }
    expect(req.headers.authorization).toBe('Bearer xoxb-fixture')
    requests.push(Object.fromEntries(params))
    if (failure === 'network') { res.destroy(); return }
    if (failure === 'ratelimited') { res.statusCode = 429; res.setHeader('retry-after', '7') }
    send(failure ? { ok: false, error: failure, ...(failure === 'missing_scope' ? { needed: 'reactions:write' } : {}) } : { ok: true })
  })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-reaction-'))
  const client = new SlackClient('xoxb-fixture', 'xapp-fixture')
  ;(client as any).web.slackApiUrl = fixture.origin + '/api/'
  const channel = new SlackChannel({ module_id: 'slack-test', port: 0, data_dir: dir, env: { SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture' } }, client)
  ;(channel as any).identity = { team_id: 'T1', user_id: 'B1', app_id: 'A1' }
  ;(channel as any).rpcClient.publishEvent = async () => {}
  const rpc = (method: string, params: unknown = {}) => (channel as any).methodHandlers.get(method)(params)
  try {
    const ts = `${Math.floor(Date.now() / 1000)}.123456`
    await channel.receive({ team_id: 'T1', api_app_id: 'A1', event: { type: 'message', channel: 'C1', user: 'U1', ts, thread_ts: '100.000001', text: '<@B1> hello' } })
    const session = (await rpc('get_sessions')).items[0]
    const params = { session_id: session.id, platform_message_id: ts, kind: 'acknowledged' }
    await expect(rpc('add_reaction', params)).resolves.toEqual({ added: true })
    failure = 'already_reacted'
    await expect(rpc('add_reaction', params)).resolves.toEqual({ added: true })
    for (const [reason, code] of [['missing_scope', 'PERMISSION_DENIED'], ['message_not_found', 'NOT_FOUND'], ['not_in_channel', 'PERMISSION_DENIED'], ['ratelimited', 'RATE_LIMITED'], ['network', 'CHANNEL_SEND_FAILED']]) {
      failure = reason
      await expect(rpc('add_reaction', params)).rejects.toMatchObject({ code, ...(reason === 'missing_scope' ? { details: { missing_scope: 'reactions:write' } } : {}), ...(reason === 'ratelimited' ? { details: { retry_after: 7 } } : {}) })
    }
    failure = ''
    await expect(rpc('add_reaction', params)).resolves.toEqual({ added: true })
    expect(requests).toHaveLength(8)
    for (const request of requests) expect(request).toMatchObject({ channel: 'C1', timestamp: ts, name: 'eyes' })
    expect((await rpc('get_sessions')).items.map((value: { id: string }) => value.id)).toEqual([session.id])
  } finally {
    await (channel as any).onStop()
    await fixture.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
