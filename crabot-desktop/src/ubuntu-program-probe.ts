// Same finite GUI/browser probe for fresh install and a verified prepared update.
// This function never registers an OS entry, selects a pair or starts business MM.
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { PreparedInstallation } from './installation-entries.js'
import { probeFailurePhase } from './ubuntu-installation.js'
import { runUbuntuProcess, ubuntuDesktopEnvironment } from './ubuntu-process.js'

export async function probeUbuntuPrograms(prepared: PreparedInstallation, options: {
  signal: AbortSignal; browserProbe: string
  runtime: { executables: { python: string }; manifest: { files: Record<string, unknown> } }
}) {
  const { runtime, signal } = options
  signal.throwIfAborted()
  async function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number, cwd: string, failureCode: string) {
    const result = await runUbuntuProcess(command, args, env, timeout, signal, cwd)
    if (result.code !== 0) {
      const phase = probeFailurePhase(result.diagnostic)
      throw Object.assign(new Error('Sandbox probe failed'), { code: failureCode, ...(phase ? { phase } : {}) })
    }
  }
  const roles = ['gui', 'chromium', 'scrapling']
  if (Object.keys(runtime.manifest.files).some(name => /\/browsers\/chromium_headless_shell-[0-9]+\/chrome-headless-shell-linux(?:64)?\/headless_shell$/.test(name))) roles.push('headless')
  const profile = await mkdtemp(path.join(tmpdir(), 'crabot-install-sandbox-')), token = randomBytes(32).toString('hex'), received = new Set<string>()
  const server = createServer((request, response) => {
    const role = request.url?.slice(token.length + 2)
    if (!role || !['gui', 'chromium', 'headless', 'scrapling'].includes(role) || request.url !== `/${token}/${role}`) { response.writeHead(404).end(); return }
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'")
      response.end(`<title>Crabot sandbox probe</title><body>Crabot<script>fetch(location.href,{method:'POST',body:'${token}:${role}'}).then(r=>r.text()).then(t=>{if(t==='verified')document.body.dataset.ready='yes'})</script>`)
    } else if (request.method === 'POST') {
      let body = ''; request.on('data', bytes => { body += bytes; if (body.length > 100) request.destroy() })
      request.on('end', () => { if (body !== `${token}:${role}`) { response.writeHead(400).end(); return }; received.add(role); response.end('verified') })
    } else response.writeHead(405).end()
  })
  server.headersTimeout = 5000; server.requestTimeout = 5000
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Probe unavailable')
    const endpoint = `http://127.0.0.1:${address.port}/${token}`
    const env = ubuntuDesktopEnvironment(process.env)
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) env[name] = profile
    env.HOME = profile; env.CRABOT_SCRAPLING_DATA_DIR = profile
    env.XDG_CACHE_HOME = path.join(profile, 'cache'); env.XDG_CONFIG_HOME = env.CHROME_CONFIG_HOME = path.join(profile, 'config')
    await mkdir(path.join(profile, 'gui'), { mode: 0o700 })
    await run(path.join(prepared.guiRoot, 'crabot-desktop'), ['--enable-sandbox', `--user-data-dir=${path.join(profile, 'gui')}`, `--installation-sandbox-probe=${endpoint}/gui`], env, 60_000, profile, 'CRABOT_INSTALL_GUI_SANDBOX')
    await run(runtime.executables.python, ['-I', '-B', options.browserProbe, prepared.coreRoot, endpoint], env, 150_000, profile, 'CRABOT_INSTALL_BROWSER_SANDBOX')
    if (!roles.every(role => received.has(role))) throw new Error('Probe network incomplete')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(profile, { recursive: true, force: true })
  }
}
