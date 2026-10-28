import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const root = process.argv[2]
if (!root) throw new Error('Usage: node check-smoke.mjs <scripted-output-directory>')
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))
const result = read('result.json')
assert.equal(result.status, 'ended'); assert.equal(result.error, undefined)
assert.equal(fs.readFileSync(path.join(root, 'workspace/smoke-answer.txt'), 'utf8'), '42')
assert.equal(result.workers.length, 1)
const worker = result.workers[0]
assert.equal(worker.origin.trigger_type, 'message')
assert.equal(worker.origin.creator_friend_id, 'eval-human')
assert.equal(worker.manager_key, 'eval-channel::smoke')
assert.deepEqual(worker.report_to, { channel_id: 'eval-channel', session_id: 'smoke' })
const context = read(`agent/workers/${worker.worker_id}/context.json`)
assert.equal(context.principal_permissions.storage.workspace_path, '/workspace')
assert.equal(context.principal_permissions.storage.access, 'readwrite')
assert.equal(context.principal_permissions.tool_access.desktop, false)
assert.ok(Object.values(context.principal_permissions.cli_access).every(value => value === 'none'))
assert.ok(result.outbox.some(message => message.content?.text?.startsWith('执行完成')))
const receipts = fs.readFileSync(path.join(root, 'evaluation.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.ok(receipts.some(row => row.type === 'rpc' && row.method === 'get_message'))
console.log('PASS: real artifact, ordinary human origin, fixed permissions, Worker target, message lookup and Manager delivery.')
