import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { retireWorkerSupervision } from '../../../src/workers/harness/supervision-retirement-migration'

const NOW = new Date('2026-09-10T00:00:00.000Z')
const roots: string[] = []

async function tempAgentDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supervision-retirement-'))
  roots.push(root)
  return path.join(root, 'agent')
}

function worker(id: string, status: string, supervision?: unknown) {
  return {
    worker_id: id,
    manager_key: 'telegram::session-1',
    task: { id: `task-${id}`, status },
    ...(supervision === undefined ? {} : { supervision }),
  }
}

async function writeLedger(agentDir: string, file: string, workers: unknown[]): Promise<string> {
  const dir = path.join(agentDir, 'worker-ledgers')
  await fs.mkdir(dir, { recursive: true })
  const raw = `${JSON.stringify({ manager_key: 'telegram::session-1', workers }, null, 2)}\n`
  await fs.writeFile(path.join(dir, file), raw)
  return raw
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('retireWorkerSupervision', () => {
  it('backs up once, reports only active periodic rules, and removes every supervision field', async () => {
    const agentDir = await tempAgentDir()
    const periodic = (expires_at: string) => ({
      version: 1,
      mode: 'periodic_report',
      pending: { due_id: 'due', kind: 'periodic_report', due_at: NOW.toISOString(), attempts: 2 },
      periodic_report: {
        interval_ms: 60_000,
        expires_at,
        report_to: { channel_id: 'telegram', session_id: 'session-1' },
      },
    })
    const original = await writeLedger(agentDir, 'telegram%3A%3Asession-1.json', [
      worker('default', 'running', { version: 1, mode: 'default', pending: { due_id: 'old' } }),
      worker('active', 'running', periodic('2026-09-11T00:00:00.000Z')),
      worker('expired', 'halted', periodic('2026-09-09T00:00:00.000Z')),
      worker('terminal', 'closed', periodic('2026-09-11T00:00:00.000Z')),
      worker('plain', 'running'),
    ])

    const report = await retireWorkerSupervision(agentDir, () => NOW)
    expect(report).toEqual({
      schema_version: 1,
      candidates: [{
        worker_id: 'active',
        manager_key: 'telegram::session-1',
        interval_ms: 60_000,
        expires_at: '2026-09-11T00:00:00.000Z',
        report_to: { channel_id: 'telegram', session_id: 'session-1' },
        requires_recreation: true,
      }],
    })

    const migrationDir = path.join(agentDir, 'migrations', 'worker-supervision-retirement-v1')
    const backup = path.join(migrationDir, 'backup', 'telegram%3A%3Asession-1.json')
    const reportPath = path.join(migrationDir, 'legacy-periodic-report-candidates.json')
    expect(await fs.readFile(backup, 'utf8')).toBe(original)
    expect(JSON.stringify(JSON.parse(await fs.readFile(
      path.join(agentDir, 'worker-ledgers', 'telegram%3A%3Asession-1.json'), 'utf8'),
    ))).not.toContain('supervision')
    expect((await fs.stat(backup)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(reportPath)).mode & 0o777).toBe(0o600)

    const artifacts = await Promise.all([backup, reportPath, path.join(migrationDir, 'completed.json')]
      .map((file) => fs.readFile(file, 'utf8')))
    expect(await retireWorkerSupervision(agentDir, () => new Date('2030-01-01T00:00:00Z'))).toEqual(report)
    expect(await Promise.all([backup, reportPath, path.join(migrationDir, 'completed.json')]
      .map((file) => fs.readFile(file, 'utf8')))).toEqual(artifacts)
  })

  it('writes an empty stable report when no ledgers exist', async () => {
    const agentDir = await tempAgentDir()
    await expect(retireWorkerSupervision(agentDir, () => NOW)).resolves.toEqual({ schema_version: 1, candidates: [] })
  })

  it('ignores LedgerStore atomic temporary files', async () => {
    const agentDir = await tempAgentDir()
    await writeLedger(agentDir, 'telegram%3A%3Asession-1.json', [
      worker('plain', 'running'),
    ])
    const temporary = path.join(
      agentDir,
      'worker-ledgers',
      '.tmp-12345678-1234-1234-1234-123456789abc.json',
    )
    await fs.writeFile(temporary, '{truncated')

    await expect(retireWorkerSupervision(agentDir, () => NOW)).resolves.toEqual({ schema_version: 1, candidates: [] })
    expect(await fs.readFile(temporary, 'utf8')).toBe('{truncated')
  })

  it('continues from create-once backups after a partial source rewrite', async () => {
    const agentDir = await tempAgentDir()
    const rule = {
      version: 1,
      mode: 'periodic_report',
      periodic_report: {
        interval_ms: 5_000,
        expires_at: '2026-09-11T00:00:00.000Z',
        report_to: { channel_id: 'telegram', session_id: 'session-1' },
      },
    }
    await writeLedger(agentDir, 'a.json', [worker('a', 'running', rule)])
    await writeLedger(agentDir, 'b.json', [worker('b', 'running', { version: 1, mode: 'default' })])
    const first = await retireWorkerSupervision(agentDir, () => NOW)
    const migrationDir = path.join(agentDir, 'migrations', 'worker-supervision-retirement-v1')
    await fs.unlink(path.join(migrationDir, 'completed.json'))
    await fs.copyFile(path.join(migrationDir, 'backup', 'b.json'), path.join(agentDir, 'worker-ledgers', 'b.json'))

    await expect(retireWorkerSupervision(agentDir, () => NOW)).resolves.toEqual(first)
    for (const file of ['a.json', 'b.json']) {
      expect(await fs.readFile(path.join(agentDir, 'worker-ledgers', file), 'utf8')).not.toContain('supervision')
    }
  })
})
