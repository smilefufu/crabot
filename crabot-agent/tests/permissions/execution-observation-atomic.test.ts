import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { persistObservation, requestObservation } from '../../src/permissions/execution-observation.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-observation-atomic-')); roots.push(root)
  const file = path.join(root, 'observation.json')
  await fs.writeFile(file, '{"before":true}')
  const record = requestObservation([], { role: 'worker', impl: 'builtin', source: 'builtin_request' })
  return { file, record }
}

// 复制 registry-windows-atomic.test 的做法：真实 PowerShell 读句柄不带 Delete 共享，
// 模拟杀软/索引器在 rename 覆盖瞬间占住目标文件。
async function holdWithoutDeleteSharing(file: string) {
  const script = "$file=[IO.File]::Open($env:CRABOT_TEST_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::Out.WriteLine('locked');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$file.Dispose()}"
  const child: ChildProcessWithoutNullStreams = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, CRABOT_TEST_LOCK_FILE: file }, windowsHide: true, stdio: 'pipe' })
  const exited = once(child, 'exit')
  let output = '', error = ''
  child.stderr.on('data', data => { error += data.toString() })
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', data => { output += data.toString(); if (output.includes('locked')) resolve() })
      child.once('error', reject)
      child.once('exit', () => reject(new Error('Owned file-lock helper exited before ready: ' + error)))
    })
  } catch (caught) { child.kill(); await exited.catch(() => {}); throw caught }
  let released: Promise<void> | undefined
  return () => released ??= (async () => { child.stdin.end('release\n'); await exited })()
}

it.skipIf(process.platform !== 'win32')('persists an observation after a short real Windows sharing lock', async () => {
  const f = await fixture(), release = await holdWithoutDeleteSharing(f.file)
  const timer = setTimeout(() => { void release() }, 400)
  try {
    await persistObservation(f.file, f.record)
    const stored = JSON.parse(await fs.readFile(f.file, 'utf8'))
    expect(stored.state).toBe('assembled')
    expect(stored.revision).toBe(f.record.revision)
  } finally { clearTimeout(timer); await release() }
}, 20000)

it.skipIf(process.platform !== 'win32')('a persistent real Windows sharing lock still rejects and preserves the previous file', async () => {
  const f = await fixture(), release = await holdWithoutDeleteSharing(f.file)
  try {
    await expect(persistObservation(f.file, f.record)).rejects.toMatchObject({ code: 'EPERM' })
    expect(await fs.readFile(f.file, 'utf8')).toBe('{"before":true}')
  } finally { await release() }
}, 20000)
