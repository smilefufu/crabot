import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TraceStore } from '../src/core/trace-store.js'
import {
  parseScheduleScriptLauncherNonce,
  ScheduleScriptRunner,
  type ScheduleScriptDelivery,
  type ScheduleScriptRunnerDeps,
} from '../src/schedule-script-runner.js'

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitUntil timed out')
}

describe('ScheduleScriptRunner', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  async function fixture(
    deliver = vi.fn<(result: ScheduleScriptDelivery) => Promise<void>>().mockResolvedValue(undefined),
    overrides: Partial<ScheduleScriptRunnerDeps> = {},
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-script-'))
    roots.push(root)
    const traceStore = new TraceStore(100, path.join(root, 'traces'))
    const markerDir = path.join(root, 'active')
    const runner = new ScheduleScriptRunner({
      traceStore,
      moduleId: 'agent-test',
      markerDir,
      cwd: root,
      deliver,
      readProcessIdentity: async (pid) => String(pid),
      ...overrides,
    })
    return { root, traceStore, markerDir, runner, deliver }
  }

  it('admits only after a 0600 marker exists, then records and delivers the bounded result', async () => {
    const f = await fixture(undefined, { readProcessIdentity: undefined })
    const source = "printf 'ok'; sleep 0.15; printf 'err' >&2"
    await f.runner.admit({
      scheduleId: 'schedule-1', triggerId: 'trigger-1', scheduleName: 'script one',
      source, sourceSha256: 'hash-1', timeoutSeconds: 2, deliverResult: true,
      targetSession: { channel_id: 'telegram', session_id: 'private-1', type: 'private' },
    })

    const markerPath = path.join(f.markerDir, 'trigger-1.json')
    expect((await fs.stat(markerPath)).mode & 0o777).toBe(0o600)
    const marker = await fs.readFile(markerPath, 'utf8')
    expect(marker).not.toContain(source)
    expect(JSON.parse(marker).process_start_identity).toMatch(/\|nonce=[0-9a-f-]{36}$/i)
    await waitUntil(async () => (await fs.readdir(f.markerDir)).length === 0)

    expect(f.deliver).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: 'schedule-1', triggerId: 'trigger-1', outcome: 'succeeded', outputTail: 'okerr',
    }))
    const trace = f.traceStore.getTraces(10, 0).traces[0]
    expect(trace).toMatchObject({ status: 'completed', trigger: { type: 'schedule', source: 'schedule-1' } })
    expect(trace.spans.map((span) => [span.type, span.status])).toEqual([
      ['schedule_script_execution', 'completed'],
      ['schedule_result_delivery', 'completed'],
    ])
  })

  it('does not deliver a result when active marker admission fails', async () => {
    const f = await fixture(undefined, {
      readProcessIdentity: async () => { throw new Error('identity unavailable') },
    })

    await expect(f.runner.admit({
      scheduleId: 'schedule-admission-failure', triggerId: 'trigger-admission-failure',
      scheduleName: 'admission failure', source: 'printf should-not-run', sourceSha256: 'hash-admission-failure',
      timeoutSeconds: 2, deliverResult: true,
      targetSession: { channel_id: 'telegram', session_id: 'private-1', type: 'private' },
    })).rejects.toThrow('Schedule script admission failed')
    await f.runner.stop()

    expect(f.deliver).not.toHaveBeenCalled()
    const trace = f.traceStore.getTraces(10, 0).traces[0]
    expect(trace).toMatchObject({ status: 'failed' })
    expect(trace.spans.map((span) => [span.type, span.status])).toEqual([
      ['schedule_script_execution', 'failed'],
    ])
  })

  it('skips overlap without starting a second process and aborts the active tree on stop', async () => {
    const f = await fixture()
    const first = {
      scheduleId: 'schedule-2', triggerId: 'trigger-a', scheduleName: 'long script',
      source: 'sleep 5', sourceSha256: 'hash-a', timeoutSeconds: 10, deliverResult: false,
      targetSession: { channel_id: 'admin-web', session_id: 'system-tasks', type: 'private' as const },
    }
    await f.runner.admit(first)
    await f.runner.admit({ ...first, triggerId: 'trigger-b', sourceSha256: 'hash-b' })

    const skipped = f.traceStore.getTraces(10, 0).traces.find((trace) => trace.trigger.summary.includes('trigger-b'))
    expect(skipped).toMatchObject({ status: 'completed', outcome: { summary: expect.stringContaining('skipped') } })
    expect(skipped?.spans[0]).toMatchObject({
      type: 'schedule_script_execution', status: 'completed', details: { outcome: 'skipped' },
    })

    await f.runner.stop()
    await waitUntil(async () => (await fs.readdir(f.markerDir)).length === 0)
    const interrupted = f.traceStore.getTraces(10, 0).traces.find((trace) => trace.trigger.summary.includes('trigger-a'))
    expect(interrupted).toMatchObject({ status: 'failed', outcome: { summary: expect.stringContaining('interrupted') } })
  })

  it('scrubs credentials and keeps a valid UTF-8 50,000-byte delivery tail', async () => {
    const previousToken = process.env.CRABOT_TOKEN
    process.env.CRABOT_TOKEN = 'must-not-leak'
    try {
      const f = await fixture()
      const source = "printf \"$CRABOT_TOKEN\"; printf 'x%.0s' {1..50001}; printf '😀'"
      await f.runner.admit({
        scheduleId: 'schedule-tail', triggerId: 'trigger-tail', scheduleName: 'tail',
        source, sourceSha256: 'hash-tail', timeoutSeconds: 2, deliverResult: true,
        targetSession: { channel_id: 'telegram', session_id: 'private-1', type: 'private' },
      })
      await waitUntil(async () => (await fs.readdir(f.markerDir)).length === 0)

      const delivered = f.deliver.mock.calls[0][0]
      expect(Buffer.byteLength(delivered.outputTail, 'utf8')).toBeLessThanOrEqual(50_000)
      expect(delivered.outputTail.endsWith('😀')).toBe(true)
      expect(delivered.outputTail).not.toContain('\uFFFD')
      expect(delivered.outputTail).not.toContain('must-not-leak')
      expect(JSON.stringify(f.traceStore.getTraces(10, 0).traces[0])).not.toContain(source)
    } finally {
      if (previousToken === undefined) delete process.env.CRABOT_TOKEN
      else process.env.CRABOT_TOKEN = previousToken
    }
  })

  it('keeps execution success independent from result delivery failure', async () => {
    const f = await fixture(vi.fn<(result: ScheduleScriptDelivery) => Promise<void>>()
      .mockRejectedValue(new Error('delivery unavailable')))
    await f.runner.admit({
      scheduleId: 'schedule-delivery', triggerId: 'trigger-delivery', scheduleName: 'delivery',
      source: 'exit 0', sourceSha256: 'hash-delivery', timeoutSeconds: 2, deliverResult: true,
      targetSession: { channel_id: 'telegram', session_id: 'private-1', type: 'private' },
    })
    await waitUntil(async () => (await fs.readdir(f.markerDir)).length === 0)

    const trace = f.traceStore.getTraces(10, 0).traces[0]
    expect(trace.status).toBe('completed')
    expect(trace.spans.map((span) => [span.type, span.status])).toEqual([
      ['schedule_script_execution', 'completed'],
      ['schedule_result_delivery', 'failed'],
    ])
  })

  it('recovers matching active processes without signalling a reused pid', async () => {
    const terminateProcess = vi.fn<(pid: number) => Promise<void>>().mockResolvedValue(undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = await fixture(undefined, {
      readProcessIdentity: async (pid) => pid === 101 ? 'same-start|nonce=nonce-a' : 'same-start|nonce=nonce-c',
      terminateProcess,
    })
    await fs.mkdir(f.markerDir, { recursive: true })
    const marker = (trigger_id: string, pid: number, nonce: string) => ({
      schema_version: 1,
      schedule_id: `schedule-${pid}`,
      trigger_id,
      source_sha256: `hash-${pid}`,
      pid,
      process_start_identity: `same-start|nonce=${nonce}`,
      created_at: NOW,
    })
    const NOW = '2026-09-10T00:00:00.000Z'
    await fs.writeFile(path.join(f.markerDir, 'matching.json'), JSON.stringify(marker('matching', 101, 'nonce-a')))
    await fs.writeFile(path.join(f.markerDir, 'reused.json'), JSON.stringify(marker('reused', 102, 'nonce-b')))

    await f.runner.recover()

    expect(terminateProcess).toHaveBeenCalledTimes(1)
    expect(terminateProcess).toHaveBeenCalledWith(101)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('identity mismatch'))
    expect(await fs.readdir(f.markerDir)).toEqual([])
    const traces = f.traceStore.getTraces(10, 0).traces
    expect(traces).toHaveLength(2)
    for (const trace of traces) expect(trace.spans[0].details).not.toHaveProperty('source')
    warn.mockRestore()
  })

  it('extracts the launcher nonce used in the process identity', () => {
    expect(parseScheduleScriptLauncherNonce(
      'node --crabot-schedule-launcher=123e4567-e89b-12d3-a456-426614174000 /bin/bash',
    )).toBe('123e4567-e89b-12d3-a456-426614174000')
    expect(() => parseScheduleScriptLauncherNonce('bash -s')).toThrow('schedule script launcher nonce unavailable')
  })
})
