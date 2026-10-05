#!/usr/bin/env node
// 使用真实 Node MCP SDK 和最终入口验证发行载荷，不依赖 BrowserManager。
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
const root = resolve(process.argv[2] ?? '.')
const require = createRequire(join(root, 'crabot-agent/package.json'))
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { resolveScraplingConfig, loadRuntime } = require(join(root, 'scripts/lib/scrapling-runtime.cjs'))
loadRuntime(root, { full: true })
const privateDir = await mkdtemp(join(tmpdir(), 'crabot-scrapling-smoke-'))
const site = createServer((req, res) => {
  if (req.url === '/cookie/set') res.setHeader('Set-Cookie', 'scrapling=retained; Path=/')
  res.setHeader('Content-Type', 'text/html')
  res.end(`<html><body style="background:#dbeafe;font-size:32px"><main>Crabot runtime verified</main><p id="cookie">${req.headers.cookie ?? ''}</p><p id="js">waiting</p><script>document.getElementById('js').textContent='JavaScript verified'</script></body></html>`)
})
site.listen(0, '127.0.0.1')
await once(site, 'listening')
const url = `http://127.0.0.1:${site.address().port}`
const entry = { is_builtin: true, name: 'scrapling', transport: 'stdio', command: 'scrapling', args: ['mcp'] }
const config = resolveScraplingConfig(root, privateDir, entry, { name: 'scrapling' })
const transport = new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env, CRABOT_SCRAPLING_SYSTEM: '1' }, stderr: 'inherit' })
const client = new Client({ name: 'crabot-release-check', version: '1' }, { capabilities: {} })
function check(value, message) { if (!value) throw new Error(message) }
async function call(name, args, text) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  check(!result.isError, `${name} failed: ${JSON.stringify(result.content)}`)
  if (text) check(JSON.stringify(result).includes(text), `${name} did not return ${text}`)
  return result
}
try {
  await client.connect(transport)
  const tools = await client.listTools()
  check(tools.tools.length === 13, 'expected thirteen upstream tools')
  const rejected = await client.callTool({ name: 'open_session', arguments: { session_type: 'dynamic', headless: false } })
  check(rejected.isError && JSON.stringify(rejected).includes('headless=true'), 'system mode must reject local headful')
  await call('make_request', { url, extraction_type: 'text' }, 'Crabot runtime verified')
  for (const name of ['fetch', 'stealthy_fetch']) await call(name, { url, extraction_type: 'text', google_search: false }, 'JavaScript verified')
  for (const session_type of ['dynamic', 'stealthy', 'static']) {
    const opened = await call(session_type === 'static' ? 'open_request_session' : 'open_session', session_type === 'static' ? {} : { session_type })
    const session_id = opened.structuredContent?.session_id
    check(session_id, 'expected structured session_id')
    const fetch = session_type === 'static' ? 'session_make_request' : 'session_fetch'
    await call(fetch, { url: url + '/cookie/set', session_id })
    await call(fetch, { url: url + '/cookie/read', session_id, extraction_type: 'text' }, 'scrapling=retained')
    if (session_type !== 'static') {
      const shot = await call('screenshot', { url, session_id })
      const png = Buffer.from(shot.content.find(c => c.type === 'image')?.data ?? '', 'base64')
      check(png.length > 4000 && png.subarray(1, 4).toString() === 'PNG', 'expected nonempty screenshot')
      await writeFile(join(privateDir, `${session_type}.png`), png)
    }
    await call('close_session', { session_id })
  }
  if (!process.argv.includes('--offline')) {
    for (const name of ['make_request', 'fetch', 'stealthy_fetch']) await call(name, { url: 'https://example.com', extraction_type: 'text' }, 'documentation examples')
  }
  // 再走 Crabot 的生产 connector，验证 schema 校验和工具输出转换。
  const { McpConnector } = require(join(root, 'crabot-agent/dist/agent/mcp-connector.js'))
  const connector = new McpConnector()
  try {
    await connector.connectAll([config])
    const tools = connector.getAllTools()
    check(tools.length === 13, 'Crabot connector must expose thirteen tools')
    const result = await tools.find(tool => tool.name === 'mcp__scrapling__fetch').call({ url, extraction_type: 'text' })
    check(!result.isError && result.output.includes('JavaScript verified'), 'Crabot connector browser call failed')
  } finally {
    await connector.disconnectAll()
  }
  // 故意留一个浏览器 session：stdio EOF 的清理也必须覆盖。
  await call('open_session', { session_type: 'dynamic' })
  console.log(JSON.stringify({ result: 'passed', tools: tools.tools.map(t => t.name), screenshots: privateDir, https: !process.argv.includes('--offline') }))
} finally {
  await client.close()
  site.close()
  if (!process.env.CRABOT_KEEP_SMOKE_ARTIFACTS) await rm(privateDir, { recursive: true, force: true })
}
