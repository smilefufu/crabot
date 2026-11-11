import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManagerSessionStore } from '../../src/manager/session-store'
import { DailyReflectionEvidence, type ReflectionEvidenceDeps } from '../../src/manager/daily-reflection-evidence'
import { createUserMessage, createAssistantMessage, createBatchToolResultMessage } from '../../src/engine/types'
import type { DailyReflectionState } from '../../src/manager/daily-reflection-types'
import type { ManagerEpisodeTrace } from '../../src/manager/trace-types'

const key = 'chat::one', reflectionKey = 'admin::reflection'
const window = { window_start: '2026-11-10T00:00:00Z', window_end: '2026-11-11T00:00:00Z' }
const at = '2026-11-10T12:00:00Z'
let root: string, store: ManagerSessionStore, provider: DailyReflectionEvidence, deps: ReflectionEvidenceDeps
let traces: Map<string, ManagerEpisodeTrace>
const previousDebug = process.env.CRABOT_DEBUG
beforeEach(async () => {
  delete process.env.CRABOT_DEBUG
  root = await fs.mkdtemp(join(tmpdir(), 'episode-log-lifecycle-'))
  store = new ManagerSessionStore(root); traces = new Map()
  deps = { managersDir: root, store, ledger: { listAllWorkers: async () => [] },
    traces: { listTraceManagerKeys: () => [key], readManagerEpisode: async id => traces.get(id),
      readManagerEpisodes: async function* () { yield* traces.values() } }, redact: value => value,
  } as ReflectionEvidenceDeps
  provider = new DailyReflectionEvidence(deps)
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (previousDebug === undefined) delete process.env.CRABOT_DEBUG; else process.env.CRABOT_DEBUG = previousDebug
  await fs.rm(root, { recursive: true, force: true })
})
const log = (id: string) => join(root, 'chat%3A%3Aone', 'episodes', id + '.jsonl')
async function evidence(id = 'episode') {
  const message = { ...createUserMessage('[人类消息]\ncurrent'), timestamp: Date.parse(at) }
  await store.save({ key, recent: [message], foldedCount: 0, rollingSummary: 'keep memory' })
  await store.appendEpisodeLog(key, id, [message])
  traces.set(id, { trace_id: id, manager_key: key, started_at: at, ended_at: at, status: 'completed',
    trigger: { type: 'human_message', summary: 'current' }, spawned_worker_ids: [], spans: [{
      span_id: 'log-mode', type: 'decision', status: 'completed', started_at: at, ended_at: at,
      details: { kind: 'episode_log', mode: 'incremental' },
    }] })
  const state: DailyReflectionState = { ...window, run_id: 'run', schedule_id: 'daily', trigger_id: 'trigger',
    target_session: { channel_id: 'admin', session_id: 'reflection', type: 'private' }, episode_ids: ['reflection'],
    analysis_worker_ids: [], directory_complete: true, read_records: {}, cursors: {}, summary_delivered: true,
    confirmation_pending: false, result: { ...window, run_id: 'run', outcome: 'completed', summary: 'done',
      pending_items: [], evidence_refs: [], completed_at: window.window_end, validation_errors: [] } }
  state.manifest = await provider.capture(state)
  expect(state.manifest.gaps).toEqual([])
  for (const record of state.manifest.records) state.read_records[record.record_ref] = true
  await store.updateDailyReflection(reflectionKey, () => state)
  return state
}
it('keeps each ordinary episode incremental instead of copying growing history', async () => {
  const history = []
  for (let index = 0; index < 20; index++) {
    const message = createUserMessage('round ' + index)
    await store.appendEpisodeLog(key, 'round-' + index, [...history, message], new Set(history.map(item => item.id)))
    history.push(message)
    const rows = (await fs.readFile(log('round-' + index), 'utf8')).trim().split('\n').map(row => JSON.parse(row))
    expect(rows.map(row => row.id)).toEqual([message.id])
  }
})
it('keeps a whole tool group when a new result belongs to an earlier call', async () => {
  const old = createUserMessage('old'), call = createAssistantMessage([{ type: 'tool_use', id: 'call', name: 'Read', input: {} }], 'tool_use')
  const result = createBatchToolResultMessage([{ tool_use_id: 'call', content: 'actual result' }])
  await store.appendEpisodeLog(key, 'tools', [old, call, result], new Set([old.id, call.id]))
  const rows = (await fs.readFile(log('tools'), 'utf8')).trim().split('\n').map(row => JSON.parse(row))
  expect(rows).toEqual([call, result])
})
it('snapshots CRABOT_DEBUG=1 at startup and preserves the full history', async () => {
  process.env.CRABOT_DEBUG = '1'; const debug = new ManagerSessionStore(root); delete process.env.CRABOT_DEBUG
  const old = createUserMessage('old'), current = createUserMessage('new')
  await debug.appendEpisodeLog(key, 'debug', [old, current], new Set([old.id]))
  expect((await fs.readFile(log('debug'), 'utf8')).trim().split('\n').map(row => JSON.parse(row))).toEqual([old, current])
})
it('deletes only reflected raw evidence after completion and confirmation, preserving state and traces', async () => {
  await evidence()
  const file = join(root, 'chat%3A%3Aone', 'state.json'), before = await fs.readFile(file)
  const trace = JSON.stringify([...traces])
  expect(await provider.cleanupConfirmed()).toBe(1)
  await expect(fs.stat(log('episode'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(file)).toEqual(before); expect(JSON.stringify([...traces])).toBe(trace)
  expect(await provider.cleanupConfirmed()).toBe(0)
})
it.each(['partial', 'unconfirmed', 'running', 'checkpoint', 'cross-window', 'appended', 'debug', 'unknown', 'other-reflection'])(
  'preserves evidence for %s', async reason => {
    const state = await evidence(), trace = traces.get('episode')!
    if (reason === 'partial') await store.updateDailyReflection(reflectionKey, current => ({ ...current!, result: { ...state.result!, outcome: 'partial' } }))
    if (reason === 'unconfirmed') await store.updateDailyReflection(reflectionKey, current => ({ ...current!, confirmation_pending: true }))
    if (reason === 'running') traces.set('episode', { ...trace, status: 'running', ended_at: undefined })
    if (reason === 'checkpoint') await fs.writeFile(join(root, 'chat%3A%3Aone', 'running.json'), JSON.stringify({ episodeId: 'episode' }))
    if (reason === 'cross-window') traces.set('episode', { ...trace, ended_at: '2026-11-11T00:01:00Z' })
    if (reason === 'appended') await fs.appendFile(log('episode'), JSON.stringify(createUserMessage('later')) + '\n')
    if (reason === 'debug') trace.spans.push({ ...trace.spans[0], span_id: 'debug-log', details: { kind: 'episode_log', mode: 'debug_full' } })
    if (reason === 'unknown') trace.spans = []
    if (reason === 'other-reflection') await store.updateDailyReflection('admin::other', () => ({ ...state, result: undefined }))
    const before = await fs.readFile(log('episode')); expect(await provider.cleanupConfirmed()).toBe(0)
    expect(await fs.readFile(log('episode'))).toEqual(before)
  })
it.each(['edited', 'redirected', 'closing'])('preserves the exact source when %s', async reason => {
  await evidence()
  if (reason === 'edited') {
    const original = await fs.readFile(log('episode'), 'utf8')
    await fs.writeFile(log('episode'), original.replace('current', 'changed'))
  }
  let outside: string | undefined
  if (reason === 'redirected') {
    outside = join(root, 'outside.jsonl'); await fs.copyFile(log('episode'), outside)
    await fs.unlink(log('episode')); await fs.symlink(outside, log('episode'))
  }
  if (reason === 'closing') deps.isClosing = () => true
  const before = await fs.readFile(log('episode'))
  expect(await provider.cleanupConfirmed()).toBe(0)
  expect(await fs.readFile(log('episode'))).toEqual(before)
  if (outside) expect(await fs.readFile(outside)).toEqual(before)
})
it('retries a failed unlink from durable completed state with a fresh store, without rerunning reflection', async () => {
  await evidence()
  const remove = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EACCES' }))
  expect(await provider.cleanupConfirmed()).toBe(0); remove.mockRestore()
  const restarted = new DailyReflectionEvidence({ ...deps, store: new ManagerSessionStore(root) })
  expect(await restarted.cleanupConfirmed()).toBe(1)
  expect((await store.load(reflectionKey)).dailyReflection).toMatchObject({ confirmation_pending: false, result: { outcome: 'completed' } })
})
