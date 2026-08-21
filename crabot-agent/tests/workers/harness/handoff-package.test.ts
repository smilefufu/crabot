import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeHandoffPackage } from '../../../src/workers/harness/handoff-package'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('writeHandoffPackage', () => {
  it('保留任务上下文和最新 native evidence，并明确记录截断', async () => {
    const workersDir = await fs.mkdtemp(join(tmpdir(), 'handoff-package-test-'))
    dirs.push(workersDir)
    const handoff = await writeHandoffPackage({
      workersDir,
      workerId: 'w-test',
      sourceIncarnationId: 'inc-1',
      workspace: '/workspace',
      createdAt: '2026-08-21T00:00:00.000Z',
      evidence: [
        { source: 'ledger', reference: 'task:t-1', summary: 'Task: migrate worker runtime' },
        { source: 'ledger', reference: 'task:t-1:goal', summary: `Goal: ${'g'.repeat(3_000)}` },
        { source: 'ledger', reference: 'incarnation:inc-1:outcome', summary: 'Source outcome: unknown' },
        { source: 'native_session', reference: 'incarnation:inc-1:1', summary: `early-progress-${'x'.repeat(8_500)}` },
        { source: 'native_session', reference: 'incarnation:inc-1:2', summary: 'latest-progress: implementation is ready for verification' },
      ],
    })

    expect(handoff.summary).toContain('Task: migrate worker runtime')
    expect(handoff.summary).toContain('Source outcome: unknown')
    expect(handoff.summary).toContain('latest-progress: implementation is ready for verification')
    expect(handoff.summary).not.toContain('early-progress-')
    expect(handoff.unavailable).toContain('evidence: truncated to retain the most recent structured activity')
  })
})
