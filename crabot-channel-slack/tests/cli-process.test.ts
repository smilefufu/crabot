import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { ProxyManager } from 'crabot-shared'
// Exercise the actual compiled supervisor, not a mock child_process.
import { startCli } from '../dist/cli-tools.js'
let root: string
let job: ReturnType<typeof startCli> | undefined
afterEach(async () => { await job?.stop().catch(() => {}); if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
it('waits for a real owned CLI and its child to exit before handoff', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-process-test-'))
  const file = path.join(root, 'fixture.cjs')
  await fs.writeFile(file, `const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`)
  job = startCli(process.execPath, [file], root)
  for (let i = 0; i < 100; i++) { try { await fs.access(path.join(root, 'pids.json')); break } catch { await new Promise(resolve => setTimeout(resolve, 30)) } }
  const pids = JSON.parse(await fs.readFile(path.join(root, 'pids.json'), 'utf8')) as number[]
  await job.stop()
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
}, 25000)
it('returns output only after a normal short command has exited', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-short-test-'))
  job = startCli(process.execPath, ['-e', 'console.log("fixture-ticket")'], root)
  expect(await job.result).toEqual({ code: 0, output: 'fixture-ticket\n' })
})

it('keeps user stdin at EOF while terminal capability queries are handled privately', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-stdin-test-'))
  job = startCli(process.execPath, ['-e', "process.stdin.on('end',()=>console.log('fixture-eof'));process.stdin.resume();setTimeout(()=>process.exit(9),2000).unref()"], root)
  expect(await job.result).toEqual({ code: 0, output: 'fixture-eof\n' })
}, 15000)

it('does not terminate a foreign process even if a stale receipt contains its PID', async () => {
  const { recoverSession } = await import('../dist/cli-tools.js')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-stale-test-'))
  await fs.mkdir(path.join(root, 'project'))
  await fs.writeFile(path.join(root, 'project/process-state.json'), JSON.stringify({ cli_pid: process.pid, supervisor_pid: process.pid }))
  await recoverSession(root)
  expect(() => process.kill(process.pid, 0)).not.toThrow()
}, 25000)
it('stops its CLI tree when the owning Admin-like parent is forcibly lost', async () => {
  const { fork } = await import('node:child_process')
  const { pathToFileURL } = await import('node:url')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-owner-test-'))
  const fixture = path.join(root, 'fixture.cjs'), ownerFile = path.join(root, 'owner.mjs')
  await fs.writeFile(fixture, `const{spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`)
  await fs.writeFile(ownerFile, `import{startCli}from ${JSON.stringify(pathToFileURL(path.resolve('dist/cli-tools.js')).href)};startCli(process.execPath,[${JSON.stringify(fixture)}],${JSON.stringify(root)});setInterval(()=>{},1000);`)
  const owner = fork(ownerFile, [], { execArgv: [], stdio: 'ignore' })
  const ownerExited = once(owner, 'exit')
  try {
    for (let i = 0; i < 100; i++) { try { await fs.access(path.join(root, 'pids.json')); break } catch { await new Promise(resolve => setTimeout(resolve, 30)) } }
    const pids = JSON.parse(await fs.readFile(path.join(root, 'pids.json'), 'utf8')) as number[]
    owner.kill('SIGKILL')
    const live = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    for (let i = 0; i < 230 && pids.some(live); i++) await new Promise(resolve => setTimeout(resolve, 100))
    expect(pids.some(live)).toBe(false)
  } finally { owner.kill('SIGKILL'); await ownerExited }
}, 30000)

it('passes the detected system proxy into an actual isolated CLI child process', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-proxy-child-'))
  const keys = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const detect = vi.spyOn(ProxyManager, 'resolveSystemProxyUrl').mockReturnValue('http://127.0.0.1:17890')
  try {
    for (const key of keys) delete process.env[key]
    job = startCli(process.execPath, ['-e', 'console.log(JSON.stringify({http:process.env.HTTP_PROXY,https:process.env.HTTPS_PROXY}))'], root, { mode: 'system' })
    const result = await job.result
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output)).toEqual({ http: 'http://127.0.0.1:17890', https: 'http://127.0.0.1:17890' })
  } finally {
    detect.mockRestore()
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
  }
})


it.skipIf(process.platform !== 'win32')('keeps the CLI and its PowerShell hooks in a hidden console from a GUI-style parent', async () => {
  const { fork, execFile } = await import('node:child_process')
  const { once } = await import('node:events')
  const { pathToFileURL } = await import('node:url')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-console-test-'))
  const fixture = path.join(root, 'inspect.cjs'), ownerFile = path.join(root, 'owner.mjs')
  const shell = path.join(process.env.SystemRoot || process.env.SYSTEMROOT!, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window); }'; $window=[ConsoleProbe]::GetConsoleWindow(); @{has_console=($window -ne [IntPtr]::Zero); visible=[ConsoleProbe]::IsWindowVisible($window)} | ConvertTo-Json -Compress`
  // The grandchild is deliberately not hidden: real Slack CLI hooks launch PowerShell themselves.
  await fs.writeFile(fixture, `const{execFileSync}=require('node:child_process');process.stdout.write(execFileSync(${JSON.stringify(shell)},${JSON.stringify(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script])},{stdio:['ignore','pipe','pipe'],timeout:10000}));`)
  await fs.writeFile(ownerFile, `import{startCli}from ${JSON.stringify(pathToFileURL(path.resolve('dist/cli-tools.js')).href)};const job=startCli(process.execPath,[${JSON.stringify(fixture)}],${JSON.stringify(root)});try{process.send(await job.result,()=>process.disconnect())}catch(error){process.send({code:1,output:String(error)},()=>process.disconnect())}`)
  const owner = fork(ownerFile, [], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let diagnostic = ''
  owner.stderr?.on('data', bytes => { diagnostic += bytes.toString() })
  const exited = once(owner, 'exit')
  const message = once(owner, 'message')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [result] = await Promise.race([
      message,
      exited.then(() => { throw new Error('Console fixture exited before result: ' + diagnostic) }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Console fixture stalled: ' + diagnostic)), 20000) }),
    ])
    expect(result.code, result.output).toBe(0)
    expect(JSON.parse(result.output)).toMatchObject({ visible: false })
    await exited
  } finally {
    clearTimeout(timer)
    if (owner.exitCode === null) {
      await new Promise<void>(resolve => execFile('taskkill', ['/PID', String(owner.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
      await exited
    }
  }
}, 45000)
