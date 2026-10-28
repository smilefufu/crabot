import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// Exercise the actual compiled supervisor, not a mock child_process.
import { startCli } from '../dist/cli-tools.js'
let root: string
let job: ReturnType<typeof startCli> | undefined
afterEach(async () => { await job?.stop().catch(() => {}); if (root) await fs.rm(root, { recursive: true, force: true }) })
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

it('does not terminate a foreign process even if a stale receipt contains its PID', async () => {
  const { recoverSession } = await import('../dist/cli-tools.js')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-stale-test-'))
  await fs.mkdir(path.join(root, 'project'))
  await fs.writeFile(path.join(root, 'project/process-state.json'), JSON.stringify({ cli_pid: process.pid, supervisor_pid: process.pid }))
  await recoverSession(root)
  expect(() => process.kill(process.pid, 0)).not.toThrow()
})
it('stops its CLI tree when the owning Admin-like parent is forcibly lost', async () => {
  const { fork } = await import('node:child_process')
  const { pathToFileURL } = await import('node:url')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-owner-test-'))
  const fixture = path.join(root, 'fixture.cjs'), ownerFile = path.join(root, 'owner.mjs')
  await fs.writeFile(fixture, `const{spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`)
  await fs.writeFile(ownerFile, `import{startCli}from ${JSON.stringify(pathToFileURL(path.resolve('dist/cli-tools.js')).href)};startCli(process.execPath,[${JSON.stringify(fixture)}],${JSON.stringify(root)});setInterval(()=>{},1000);`)
  const owner = fork(ownerFile, [], { execArgv: [], stdio: 'ignore' })
  try {
    for (let i = 0; i < 100; i++) { try { await fs.access(path.join(root, 'pids.json')); break } catch { await new Promise(resolve => setTimeout(resolve, 30)) } }
    const pids = JSON.parse(await fs.readFile(path.join(root, 'pids.json'), 'utf8')) as number[]
    owner.kill('SIGKILL')
    const live = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    for (let i = 0; i < 230 && pids.some(live); i++) await new Promise(resolve => setTimeout(resolve, 100))
    expect(pids.some(live)).toBe(false)
  } finally { owner.kill('SIGKILL') }
}, 30000)
