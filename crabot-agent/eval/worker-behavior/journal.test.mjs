import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJournal, readJournal, auditSlots } from './journal.mjs'

test('interruption retains completed requests and receipts without inventing an outcome', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-journal-'))
  const file = path.join(root, 'results.jsonl')
  try {
    const log = createJournal(file)
    log({ kind: 'started', id: 'case-1' })
    log({ kind: 'request_started', id: 'case-1', request_id: 'q1' })
    log({ kind: 'request_result', id: 'case-1', request_id: 'q1', status: 'response' })
    log({ kind: 'tool_receipt', id: 'case-1', receipt: { output: 'recorded' } })
    log({ kind: 'request_started', id: 'case-1', request_id: 'q2' })
    fs.appendFileSync(file, '{"kind":')
    const rows = readJournal(file)
    assert.equal(rows.at(-1).kind, 'truncated_record')
    const audit = auditSlots({ order: [{ id: 'case-1' }, { id: 'case-2' }] }, rows)
    assert.deepEqual(audit[0], { id: 'case-1', status: 'interrupted', findings: undefined, request_attempts: 2, recorded_responses: 1, pending_requests: ['q2'] })
    assert.equal(audit[1].status, 'not_started')
    assert.equal(rows.filter(r => r.kind === 'tool_receipt').length, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
