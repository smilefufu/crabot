import { expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SlackClient } from '../src/slack-client.js'
import { formatSlackText } from '../src/format.js'

it('serializes native human mentions through the real Slack SDK, including visible blocks and notification text', async () => {
  const received: URLSearchParams[] = []
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    received.push(new URLSearchParams(Buffer.concat(chunks).toString()))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ts: '1800000000.000001' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new SlackClient('xoxb-fixture', 'xapp-fixture')
  ;(client as any).web.slackApiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`
  try {
    const [part] = formatSlackText('**请确认修复结果**', ['UFUFU'])
    await client.call('chat.postMessage', { channel: 'CGROUP', text: part.source, blocks: part.blocks, mrkdwn: true })
    expect(received).toHaveLength(1)
    expect(received[0].get('channel')).toBe('CGROUP')
    expect(received[0].get('text')).toBe('<@UFUFU> **请确认修复结果**')
    expect(JSON.parse(received[0].get('blocks')!)).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '<@UFUFU>' } },
      { type: 'markdown', text: '**请确认修复结果**' },
    ])
  } finally {
    await client.stop()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
