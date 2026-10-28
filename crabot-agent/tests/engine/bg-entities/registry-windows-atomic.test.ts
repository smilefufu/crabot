import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry.js'
import type { BgAgentRegistryRecord } from '../../../src/engine/bg-entities/types.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-registry-sharing-')); roots.push(root)
  const file = path.join(root, 'registry.json'), registry = new BgEntityRegistry(file)
  const record: BgAgentRegistryRecord = { entity_id: 'agent-owned', type: 'agent', status: 'running',
    owner: { friend_id: 'fixture', session_id: 'fixture' }, spawned_by_task_id: 'fixture', spawned_at: new Date().toISOString(),
    exit_code: null, ended_at: null, last_activity_at: new Date().toISOString(), task_description: 'fixture',
    messages_log_file: path.join(root, 'messages.jsonl'), result_file: null }
  await registry.register(record)
  return { file, registry, before: await fs.readFile(file, 'utf8') }
}

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
  } catch (error) { child.kill(); await exited.catch(() => {}); throw error }
  let released: Promise<void> | undefined
  return () => released ??= (async () => { child.stdin.end('release\n'); await exited })()
}

it.skipIf(process.platform !== 'win32')('commits the same atomic registry update after a short real Windows sharing lock', async () => {
  const f = await fixture(), release = await holdWithoutDeleteSharing(f.file)
  const timer = setTimeout(() => { void release() }, 150)
  try {
    const updated = await f.registry.update('agent-owned', { status: 'completed', exit_code: 0, ended_at: new Date().toISOString() })
    expect(updated?.status).toBe('completed')
    expect((await f.registry.get('agent-owned'))?.status).toBe('completed')
  } finally { clearTimeout(timer); await release() }
}, 15000)

it.skipIf(process.platform !== 'win32')('a persistent real Windows sharing lock rejects and preserves the previous registry', async () => {
  const f = await fixture(), release = await holdWithoutDeleteSharing(f.file)
  try {
    await expect(f.registry.update('agent-owned', { status: 'completed' })).rejects.toMatchObject({ code: 'EPERM' })
    expect(await fs.readFile(f.file, 'utf8')).toBe(f.before)
  } finally { await release() }
}, 15000)
