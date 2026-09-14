import fs from 'node:fs'

export function createJournal(file) {
  return value => {
    const fd = fs.openSync(file, 'a', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(value) + '\n')
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
  }
}

export function readJournal(file) {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const partial = lines.pop()
  const rows = lines.filter(Boolean).map(JSON.parse)
  // A killed write may leave only the final record incomplete; earlier corruption is an error.
  if (partial) rows.push({ kind: 'truncated_record', bytes: Buffer.byteLength(partial) })
  return rows
}

export function auditSlots(plan, rows) {
  return plan.order.map(slot => {
    const final = rows.findLast(r => ['result', 'recovery_result'].includes(r.kind) && r.id === slot.id)
    const requests = rows.filter(r => r.kind === 'request_started' && r.id === slot.id)
    const responses = rows.filter(r => r.kind === 'request_result' && r.id === slot.id)
    return { id: slot.id, status: final?.status ?? (rows.some(r => r.id === slot.id) ? 'interrupted' : 'not_started'),
      findings: final?.findings, request_attempts: requests.length, recorded_responses: responses.length,
      pending_requests: requests.filter(q => !responses.some(r => r.request_id === q.request_id)).map(q => q.request_id) }
  })
}
