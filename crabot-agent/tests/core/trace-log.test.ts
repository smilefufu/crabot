import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TraceLog } from '../../src/core/trace-log.js'
import type { AgentSpan, AgentTrace, ResumeCheckpoint } from '../../src/types.js'

let root: string
let log: TraceLog
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-log-')); log = new TraceLog(root) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const started_at = '2026-11-16T01:02:03.000Z'
function trace(): AgentTrace {
  return { trace_id: 't-1', module_id: 'agent', started_at, status: 'running', trigger: { type: 'task', summary: 'w' }, spans: [] }
}
function span(id: string): AgentSpan {
  return { span_id: id, trace_id: 't-1', type: 'tool_call', started_at, status: 'running', details: { tool_name: 'Read', input_summary: 'x' } }
}
function checkpoint(): ResumeCheckpoint {
  return { agent_version: '1', system_prompt: 's', messages: [], worker_state: { todo_items: [] } }
}

function appendScript() {
  log.start('t-1', started_at, 'agent', trace())
  log.append('t-1', started_at, { type: 'span_upsert', span: span('a') })
  log.append('t-1', started_at, { type: 'span_patch', span_id: 'a', patch: { status: 'completed', ended_at: started_at, duration_ms: 5 } })
  log.append('t-1', started_at, { type: 'checkpoint', checkpoint: checkpoint() })
  log.append('t-1', started_at, { type: 'span_upsert', span: span('b') })
  log.append('t-1', started_at, { type: 'trace_end', status: 'completed', ended_at: started_at })
}

describe('append-only trace log', () => {
  it('folds span upserts/patches, checkpoint and end into a trace', () => {
    appendScript()
    const folded = log.fold('t-1', started_at)
    expect(folded?.ended).toBe(true)
    expect(folded?.trace.status).toBe('completed')
    expect(folded?.trace.spans).toHaveLength(2)
    expect(folded?.trace.spans[0]).toMatchObject({ span_id: 'a', status: 'completed', duration_ms: 5 })
    expect((folded?.trace as AgentTrace).resume_checkpoint?.agent_version).toBe('1')
  })

  it('ignores one partial trailing line and keeps earlier records', () => {
    appendScript()
    const file = log.file('t-1', started_at)
    fs.appendFileSync(file, '{"v":1,"type":"span_up', 'utf-8')
    expect(log.fold('t-1', started_at)?.ended).toBe(true)
    expect(log.lastSeq('t-1', started_at)).toBe(5)
  })

  it('expires only finished traces and never an active one', () => {
    const old = Date.now() - 8 * 86_400_000
    const oldIso = new Date(old).toISOString()
    log.start('t-1', started_at, 'agent', trace())
    log.append('t-1', started_at, { type: 'trace_end', status: 'completed', ended_at: oldIso, ts: oldIso })
    log.start('t-2', started_at, 'agent', { ...trace(), trace_id: 't-2' })
    const deletable = log.deletable(Date.now() - 7 * 86_400_000)
    expect(deletable.map(item => path.basename(item.file))).toEqual(['t-1.jsonl'])
  })

  it('treats an outcome patch after the end marker as finished, and a new header as reopened', () => {
    appendScript()
    log.append('t-1', started_at, { type: 'outcome_patch', outcome: { summary: 'later metadata' } })
    expect(log.ended(log.file('t-1', started_at)).ended).toBe(true)
    log.append('t-1', started_at, { type: 'trace_start', kind: 'agent', trace: { ...trace(), status: 'running' } })
    expect(log.ended(log.file('t-1', started_at)).ended).toBe(false)
  })

  it('compacts at the latest checkpoint and keeps the resume state', () => {
    appendScript()
    expect(log.compact('t-1', started_at, 1)).toBe(true)
    const folded = log.fold('t-1', started_at)
    expect(folded?.trace.spans.map(item => item.span_id)).toEqual(['b'])
    expect(folded?.trace.resume_checkpoint?.agent_version).toBe('1')
    expect(folded?.ended).toBe(true)
  })

  it('compacts without a checkpoint by keeping a tail budget', () => {
    log.start('t-1', started_at, 'agent', trace())
    for (let index = 0; index < 20; index++) log.append('t-1', started_at, { type: 'span_upsert', span: span(String(index)) })
    const before = log.fold('t-1', started_at)!
    log.compact('t-1', started_at, 800)
    const after = log.fold('t-1', started_at)!
    expect(after.trace.spans.length).toBeLessThan(before.trace.spans.length)
    expect(after.trace.spans.length).toBeGreaterThan(0)
    expect(after.trace.spans.at(-1)).toMatchObject({ span_id: '19' })
  })
})
