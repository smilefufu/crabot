import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'

test('Windows stop requests MM shutdown before terminating its logging supervisor', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'crabot-win-stop-'))
  const marker = join(root, 'shutdown')
  const premature = join(root, 'premature-termination')
  const server = createServer((req, res) => {
    if (req.url !== '/shutdown') { res.writeHead(404); res.end(); return }
    fs.writeFile(marker, 'modules drained').then(() => res.end('{}'))
  })
  try {
    await fs.mkdir(join(root, 'lib'))
    await fs.writeFile(join(root, '_preflight.mjs'), '')
    await fs.copyFile(new URL('../../stop.mjs', import.meta.url), join(root, 'stop.mjs'))
    for (const file of ['pid.mjs', 'supervisor-shutdown.mjs']) await fs.copyFile(new URL(`../${file}`, import.meta.url), join(root, 'lib', file))
    await fs.writeFile(join(root, 'lib/instance.mjs'), 'export const resolveCliDataDir=()=>process.env.DATA_DIR')
    await fs.writeFile(join(root, 'lib/cli-lock.mjs'), 'export const acquireCliLock=async()=>null;export const releaseCliLock=()=>{}')
    await fs.writeFile(join(root, 'mm.pid'), '43210')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = server.address().port
    const preload = join(root, 'simulate.mjs')
    await fs.writeFile(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'win32'});
process.kill=(pid,signal)=>{if(signal==='SIGTERM'){fs.writeFileSync(process.env.PREMATURE,'unsafe signal');fs.writeFileSync(process.env.MARKER,'MM lost its log pipe');return true}if(fs.existsSync(process.env.MARKER))throw Object.assign(new Error('gone'),{code:'ESRCH'});return true};
cp.execSync=command=>{if(command==='netstat -ano -p TCP')return fs.existsSync(process.env.MARKER)?'':'  TCP 127.0.0.1:'+process.env.MM_PORT+' 0.0.0.0:0 LISTENING 43211';return ''};syncBuiltinESMExports()`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', preload, join(root, 'stop.mjs')], { env: { ...process.env, DATA_DIR: root, CRABOT_PORT_OFFSET: String(port - 19000), CRABOT_CLI_LOCK_HELD: '1', PREMATURE: premature, MARKER: marker, MM_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
      const timer = setTimeout(() => { child.kill(); reject(new Error('stop fixture timed out')) }, 10_000)
      child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve({ code, output }) })
    })
    assert.equal(result.code, 0, result.output)
    assert.equal(await fs.readFile(marker, 'utf8'), 'modules drained')
    await assert.rejects(fs.access(premature), { code: 'ENOENT' })
  } finally {
    server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
