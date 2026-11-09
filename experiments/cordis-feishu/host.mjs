import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'

/** Experiment host only: it does not replace production Admin or its authorization chain. */
export async function createHost(installDir, configs) {
  const require = createRequire(path.resolve(installDir, 'package.json'))
  const { Context } = require('cordis')
  const plugin = require('crabot-channel-feishu')
  const ctx = new Context()
  ctx.provide('crabotChannels', new Map())
  const events = []
  ctx.on('crabot/channel-event', event => { events.push(event) })
  const web = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404).end(); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ channels: [...ctx.crabotChannels.keys()] }))
  })
  try {
    for (const config of configs) await ctx.plugin(plugin, config)
    await new Promise((resolve, reject) => {
      web.once('error', reject)
      web.listen(0, '127.0.0.1', resolve)
    })
    return {
      channels: ctx.crabotChannels, events, port: web.address().port,
      async close() {
        try { await ctx.fiber.dispose() }
        finally { await new Promise((resolve, reject) => web.close(error => error ? reject(error) : resolve())) }
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
