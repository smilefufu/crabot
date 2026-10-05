import { readFileSync, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

// 仅替换旧 CLI 的 release 下载；Memory 和浏览器请求继续使用真实网络。
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url === 'https://github.com/smilefufu/crabot/releases/latest') {
    return new Response(null, { status: 302, headers: { location: 'https://github.com/smilefufu/crabot/releases/tag/v2099.1.1-system-audit' } })
  }
  const artifact = url.startsWith('https://github.com/smilefufu/crabot/releases/download/v2099.1.1-system-audit/')
  if (artifact && url.endsWith('.tar.gz.sha256')) return new Response(readFileSync(process.env.CRABOT_AUDIT_SHA, 'utf8'))
  if (artifact && url.endsWith('.tar.gz')) return new Response(Readable.toWeb(createReadStream(process.env.CRABOT_AUDIT_ARCHIVE)))
  return originalFetch(input, init)
}
