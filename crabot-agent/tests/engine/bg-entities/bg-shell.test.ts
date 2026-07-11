import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import { spawnPersistentShell, readProcStartTime, runShellWithGrace } from '../../../src/engine/bg-entities/bg-shell'
import type { BgShellRegistryRecord } from '../../../src/engine/bg-entities/types'
import * as resolveBashPathModule from '../../../src/utils/resolve-bash-path'

// ---------------------------------------------------------------------------
// readProcStartTime：必须返回真实的进程启动时间（稳定、跨重启可比对），而非 wall-clock now。
// 回归守卫：中文等 locale 下 `ps -o lstart=` 输出本地化日期，若不强制 LC_ALL=C 会解析失败、
// 退化为 now，导致 isShellAlive 防-PID-复用校验跨重启误判活进程为死（生产实测踩到）。
// ---------------------------------------------------------------------------

describe('readProcStartTime', () => {
  it('返回真实启动时间（约 2s 前），而非 now；两次调用稳定一致', async () => {
    const child = spawn('sleep', ['10'])
    try {
      await new Promise((r) => setTimeout(r, 2100)) // 让启动时间明显早于 now
      const t1 = await readProcStartTime(child.pid!)
      const t2 = await readProcStartTime(child.pid!)
      expect(Number.isNaN(new Date(t1).getTime())).toBe(false) // 可解析
      expect(t1).toBe(t2) // 稳定（真实启动时间不随调用时刻变）
      // 关键：返回的是真实启动时间（~2s 前），不是 now。坏 locale 下未强制 LC_ALL=C 会退化为 now → 此断言失败。
      expect(Date.now() - new Date(t1).getTime()).toBeGreaterThan(1000)
    } finally {
      child.kill('SIGKILL')
    }
  })
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let tmpDir: string
let registry: BgEntityRegistry
const spawnedPids: number[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-shell-test-'))
  process.env.DATA_DIR = tmpDir
  registry = new BgEntityRegistry()
})

afterEach(() => {
  // Kill any still-running child processes so vitest doesn't hang.
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already dead — ignore
    }
  }
  spawnedPids.length = 0

  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spawnPersistentShell', () => {
  it('returns entity_id immediately in shell_<hex> format', async () => {
    const entityId = await spawnPersistentShell({
      command: 'sleep 5',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-1',
      cwd: process.cwd(),
      registry,
    })

    expect(entityId).toMatch(/^shell_[0-9a-f]{12}$/)

    // track pid for cleanup
    const rec = await registry.get(entityId)
    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)
  })

  it('registry immediately contains a running record after spawn', async () => {
    const entityId = await spawnPersistentShell({
      command: 'sleep 5',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-2',
      cwd: process.cwd(),
      registry,
    })

    const rec = await registry.get(entityId)
    expect(rec).not.toBeNull()
    expect(rec?.status).toBe('running')
    expect(rec?.type).toBe('shell')
    expect((rec as BgShellRegistryRecord).command).toBe('sleep 5')
    expect((rec as BgShellRegistryRecord).pid).toBeGreaterThan(0)

    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)
  })

  it('log file is created on disk immediately after spawn', async () => {
    const entityId = await spawnPersistentShell({
      command: 'sleep 5',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-3',
      cwd: process.cwd(),
      registry,
    })

    const rec = await registry.get(entityId)
    expect(rec).not.toBeNull()

    const { existsSync } = await import('node:fs')
    expect(existsSync((rec as BgShellRegistryRecord).log_file)).toBe(true)

    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)
  })

  it('process stdout is written to the log file', async () => {
    const entityId = await spawnPersistentShell({
      command: 'echo hello_bg_shell',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-4',
      cwd: process.cwd(),
      registry,
    })

    // Give process time to write output and exit.
    await sleep(200)

    const rec = await registry.get(entityId)
    expect(rec).not.toBeNull()

    const logContent = readFileSync((rec as BgShellRegistryRecord).log_file, 'utf8')
    expect(logContent).toContain('hello_bg_shell')
  })

  it('registry status becomes completed with exit_code=0 after clean exit', async () => {
    const entityId = await spawnPersistentShell({
      command: 'exit 0',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-5',
      cwd: process.cwd(),
      registry,
    })

    // Wait for process to exit and registry to be updated.
    // Uses poll loop to avoid flakiness from variable process startup time.
    for (let i = 0; i < 20; i++) {
      await sleep(50)
      const rec = await registry.get(entityId)
      if (rec?.status !== 'running') break
    }

    const rec = await registry.get(entityId)
    expect(rec?.status).toBe('completed')
    expect(rec?.exit_code).toBe(0)
    expect(rec?.ended_at).not.toBeNull()
  })

  it('registry status becomes failed with non-zero exit_code', async () => {
    const entityId = await spawnPersistentShell({
      command: 'exit 7',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-6',
      cwd: process.cwd(),
      registry,
    })

    // Poll for status change (up to 1s).
    for (let i = 0; i < 20; i++) {
      await sleep(50)
      const rec = await registry.get(entityId)
      if (rec?.status !== 'running') break
    }

    const rec = await registry.get(entityId)
    expect(rec?.status).toBe('failed')
    expect(rec?.exit_code).toBe(7)
    expect(rec?.ended_at).not.toBeNull()
  })

  it('owner and spawned_by_task_id are correctly persisted in registry', async () => {
    const owner = { friend_id: 'user-X', session_id: 'ses-99', channel_id: 'chan-1' }
    const entityId = await spawnPersistentShell({
      command: 'sleep 5',
      owner,
      spawned_by_task_id: 'task-7',
      cwd: process.cwd(),
      registry,
    })

    const rec = await registry.get(entityId)
    expect(rec?.owner).toEqual(owner)
    expect(rec?.spawned_by_task_id).toBe('task-7')

    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)
  })

  it('detached process survives after caller closes its fd (log still written)', async () => {
    // Spawn a process that sleeps briefly then writes output — the caller has
    // already closed its copy of the log fd by the time writing happens.
    const entityId = await spawnPersistentShell({
      command: 'sleep 0.1 && echo survived_detach',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-8',
      cwd: process.cwd(),
      registry,
    })

    // Wait enough for the process to complete and write.
    await sleep(500)

    const rec = await registry.get(entityId)
    expect(rec).not.toBeNull()

    const logContent = readFileSync((rec as BgShellRegistryRecord).log_file, 'utf8')
    expect(logContent).toContain('survived_detach')
    expect(rec?.status).toBe('completed')
  })
})

describe('runShellWithGrace', () => {
  it('returns inline when a short command starts a background child that keeps stdout open', async () => {
    const startedAt = Date.now()

    const result = await runShellWithGrace({
      command: 'sleep 2 & echo started',
      cwd: process.cwd(),
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-inline-background-child',
      registry,
      gracePeriodMs: 1_500,
    })

    expect(Date.now() - startedAt).toBeLessThan(1_500)
    expect(result.kind).toBe('inline')
    if (result.kind !== 'inline') {
      return
    }
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('started\n')
  }, 5_000)

  it('falls back to sidecar redirection when mkfifo is unavailable', async () => {
    const fakeBin = path.join(tmpDir, 'bin')
    rmSync(fakeBin, { recursive: true, force: true })
    mkdirSync(fakeBin, { recursive: true })
    const fakeMkfifo = path.join(fakeBin, 'mkfifo')
    writeFileSync(fakeMkfifo, '#!/bin/sh\necho mkfifo unavailable >&2\nexit 1\n')
    chmodSync(fakeMkfifo, 0o755)

    const oldPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${oldPath ?? ''}`
    try {
      const result = await runShellWithGrace({
        command: 'echo hello',
        cwd: process.cwd(),
        owner: { friend_id: 'user-A' },
        spawned_by_task_id: 'task-inline-mkfifo-fallback',
        registry,
        gracePeriodMs: 1_000,
      })

      expect(result.kind).toBe('inline')
      if (result.kind !== 'inline') {
        return
      }
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello\n')
      expect(result.stderr).toBe('')
    } finally {
      process.env.PATH = oldPath
    }
  })

  it('returns spawn_error and removes temp log artifacts when bash resolution throws before child spawn', async () => {
    const resolveBashPathSpy = vi.spyOn(resolveBashPathModule, 'resolveBashPath').mockReturnValue(null)

    try {
      await expect(
        runShellWithGrace({
          command: 'echo should_not_run',
          cwd: process.cwd(),
          owner: { friend_id: 'user-A' },
          spawned_by_task_id: 'task-inline-spawn-error',
          registry,
          gracePeriodMs: 1_000,
        }),
      ).resolves.toMatchObject({
        kind: 'spawn_error',
        message: resolveBashPathModule.BASH_NOT_FOUND_MESSAGE,
      })

      const logsDir = path.join(tmpDir, 'agent', 'bg-entities', 'logs')
      expect(existsSync(logsDir)).toBe(true)
      expect(readdirSync(logsDir)).toEqual([])
    } finally {
      resolveBashPathSpy.mockRestore()
    }
  })

  it('inline capture waits for late inherited stdout/stderr writers before cleanup', async () => {
    const stdoutChunk = 'O'.repeat(200_000)
    const stderrChunk = 'E'.repeat(200_000)

    const result = await runShellWithGrace({
      command: [
        `python3 -c "import sys,time; time.sleep(0.2); sys.stdout.write('${stdoutChunk}')" &`,
        `python3 -c "import sys,time; time.sleep(0.2); sys.stderr.write('${stderrChunk}')" &`,
      ].join('\n'),
      cwd: process.cwd(),
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-inline-late-writers',
      registry,
      gracePeriodMs: 1_000,
    })

    expect(result.kind).toBe('inline')
    if (result.kind !== 'inline') {
      return
    }
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(stdoutChunk)
    expect(result.stderr).toBe(stderrChunk)
  }, 5_000)
})
