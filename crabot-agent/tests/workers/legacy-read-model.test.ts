import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readLegacyTraceEvents } from '../../src/workers/legacy-source-reader.js'

const directories: string[] = []

async function traceDir(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'legacy-read-model-'))
  directories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('legacy trace read model', () => {
  it('merges selected traces in stable time order and reports missing references without failing detail', async () => {
    const directory = await traceDir()
    await fs.writeFile(join(directory, 'traces-2026-01-01.jsonl'), [
      JSON.stringify({ trace_id: 'late', related_task_id: 'old', started_at: '2026-01-01T02:00:00.000Z', outcome: { summary: 'late summary' } }),
      JSON.stringify({ trace_id: 'early', related_task_id: 'old', started_at: '2026-01-01T01:00:00.000Z', outcome: { summary: 'early summary' } }),
      'broken-json',
    ].join('\n'))

    const result = await readLegacyTraceEvents(directory, ['late', 'missing', 'early'])

    expect(result.entries.map((entry) => entry.event.summary)).toEqual(['early summary', 'late summary'])
    expect(result.unavailable_reason).toBe(
      '1 legacy trace reference(s) unavailable; 1 malformed or unreadable legacy trace record(s)',
    )
  })

  it('reports unreadable source as unavailable rather than throwing', async () => {
    const result = await readLegacyTraceEvents(join(tmpdir(), 'does-not-exist-legacy-traces'), ['gone'])
    expect(result).toEqual({ entries: [], unavailable_reason: '1 legacy trace reference(s) unavailable' })
  })
})
