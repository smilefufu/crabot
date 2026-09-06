/**
 * Manager episode trace（protocol-agent-v3 §8.4 / P6-A 阶段 1）测试：
 * start/flush/rebuild/finish/restart reconcile、legacy 无 kind 行兼容、
 * manager 索引隔离、单次收口、cleanup 不删 running、敏感字段不落盘。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TraceStore } from '../../src/core/trace-store.js'
import type { ManagerEpisodeTrigger } from '../../src/manager/trace-types.js'
import type { ManagerKey } from '../../src/workers/harness/ledger-types.js'

const KEY_A = 'wechat::sess-a' as ManagerKey
const KEY_B = 'wechat::sess-b' as ManagerKey

const TRIGGER: ManagerEpisodeTrigger = { type: 'human_message', summary: '用户问了件事', source: 'wechat' }

describe('TraceStore manager episode traces', () => {
  let dir: string
  let store: TraceStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-manager-trace-'))
    store = new TraceStore(100, dir, 'traces-running.jsonl', 'traces-v3-')
  })

  afterEach(() => {
    store.stopFlushTimer()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('start creates a persisted running episode; finish closes it exactly once with outcome/usage', () => {
    store.startManagerEpisode('ep-1', KEY_A, TRIGGER)
    const running = store.getManagerEpisode('ep-1')!
    expect(running.status).toBe('running')
    expect(running.manager_key).toBe(KEY_A)

    // start 即落盘（episode admission 不变量）
    const today = new Date().toISOString().slice(0, 10)
    const archive = fs.readFileSync(path.join(dir, `traces-v3-${today}.jsonl`), 'utf-8')
    expect(archive).toContain('"kind":"manager_episode"')
    expect(archive).toContain('"trace_id":"ep-1"')

    store.finishManagerEpisode('ep-1', {
      status: 'completed',
      outcome: { summary: 'done' },
      total_usage: { input_tokens: 10, output_tokens: 5 },
    })
    const finished = store.getManagerEpisode('ep-1')!
    expect(finished.status).toBe('completed')
    expect(finished.ended_at).toBeDefined()
    expect(finished.total_usage?.input_tokens).toBe(10)

    // 二次收口幂等 no-op
    store.finishManagerEpisode('ep-1', { status: 'failed', outcome: { summary: 'should-not-apply' } })
    expect(store.getManagerEpisode('ep-1')!.status).toBe('completed')
    expect(store.getManagerEpisode('ep-1')!.outcome?.summary).toBe('done')
  })

  it('append/finish spans and spawned worker ids are tracked', () => {
    store.startManagerEpisode('ep-2', KEY_A, TRIGGER)
    store.appendManagerSpan('ep-2', {
      span_id: 'sp-1', type: 'llm_call', started_at: new Date().toISOString(), status: 'running', details: { model: 'x' },
    })
    store.finishManagerSpan('ep-2', 'sp-1', { status: 'completed', details: { model: 'x', usage: { input_tokens: 3, output_tokens: 1 } } })
    store.addSpawnedWorkerToManagerEpisode('ep-2', 'w-1')
    store.addSpawnedWorkerToManagerEpisode('ep-2', 'w-1')
    store.addSpawnedWorkerToManagerEpisode('ep-2', 'w-2')
    const episode = store.getManagerEpisode('ep-2')!
    expect(episode.spans[0].status).toBe('completed')
    expect(episode.spans[0].ended_at).toBeDefined()
    expect(episode.spawned_worker_ids).toEqual(['w-1', 'w-2'])
  })

  it('keeps an interrupted episode resumable instead of marking the whole episode failed', () => {
    store.startManagerEpisode('ep-resume', KEY_A, TRIGGER)
    store.appendManagerSpan('ep-resume', {
      span_id: 'interrupted-call', type: 'tool_call', started_at: new Date().toISOString(), status: 'running', details: { name: 'send_message' },
    })
    store.reconcileInterruptedManagerEpisodes(new Set(['ep-resume']))
    expect(store.getManagerEpisode('ep-resume')!.status).toBe('running')
    expect(store.getManagerEpisode('ep-resume')!.spans[0].status).toBe('failed')
    store.startManagerEpisode('ep-resume', KEY_A, TRIGGER, true)
    store.finishManagerEpisode('ep-resume', { status: 'completed', outcome: { summary: 'resumed' } })
    expect(store.getManagerEpisode('ep-resume')!.status).toBe('completed')
    expect(store.listManagerEpisodes(KEY_A).items).toHaveLength(1)
  })

  it('finish closes leftover running spans with the episode status', () => {
    store.startManagerEpisode('ep-3', KEY_A, TRIGGER)
    store.appendManagerSpan('ep-3', {
      span_id: 'sp-x', type: 'tool_call', started_at: new Date().toISOString(), status: 'running', details: {},
    })
    store.finishManagerEpisode('ep-3', { status: 'failed', outcome: { summary: 'boom', error: 'controlled' } })
    const episode = store.getManagerEpisode('ep-3')!
    expect(episode.spans[0].status).toBe('failed')
    expect(episode.outcome?.error).toBe('controlled')
  })

  it('running episodes enter the in-flight flush and survive rebuild from disk', () => {
    store.startManagerEpisode('ep-4', KEY_A, TRIGGER)
    // 强制一次 flush（模拟进程被杀前的最后状态）
    ;(store as unknown as { flushInFlightTraces(): void }).flushInFlightTraces()
    expect(fs.readFileSync(path.join(dir, 'traces-running.jsonl'), 'utf-8')).toContain('ep-4')

    // 新实例从磁盘 rebuild：archive 行优先（带 kind），running 文件兜底
    const rebuilt = new TraceStore(100, dir, 'traces-running.jsonl', 'traces-v3-')
    expect(rebuilt.getManagerEpisode('ep-4')).toBeDefined()
    expect(rebuilt.countManagerEpisodes(KEY_A)).toBe(1)
    expect(rebuilt.listTraceManagerKeys()).toContain(KEY_A)
    rebuilt.stopFlushTimer()
  })

  it('reconcileInterruptedManagerEpisodes closes leftover running as failed/interrupted preserving spans', () => {
    store.startManagerEpisode('ep-5', KEY_A, TRIGGER)
    store.appendManagerSpan('ep-5', {
      span_id: 'sp-live', type: 'llm_call', started_at: new Date().toISOString(), status: 'running', details: { n: 1 },
    })
    store.appendManagerSpan('ep-5', {
      span_id: 'tool-live', type: 'tool_call', started_at: new Date().toISOString(), status: 'running',
      details: { call_id: 'call-live', name: 'slow_tool', input_summary: '{}' },
    })
    // span 增量走 deferred flush（覆盖式 running 文件）；生产由 15s 定时器兜底。
    ;(store as unknown as { flushInFlightTraces(): void }).flushInFlightTraces()
    const rebuilt = new TraceStore(100, dir, 'traces-running.jsonl', 'traces-v3-')
    rebuilt.reconcileInterruptedManagerEpisodes()
    const episode = rebuilt.getManagerEpisode('ep-5')!
    expect(episode.status).toBe('failed')
    expect(episode.outcome?.summary).toContain('interrupted')
    expect(episode.spans[0].status).toBe('failed')
    expect(episode.spans[0].details).toEqual({ n: 1 })
    expect(episode.spans[1]).toMatchObject({
      status: 'failed',
      details: {
        call_id: 'call-live',
        output_summary: '[interrupted: agent restarted]',
        is_error: true,
      },
    })
    rebuilt.stopFlushTimer()
  })

  it('legacy no-kind lines still parse and never leak manager records into legacy index', async () => {
    // 手写一条无 kind 的 legacy AgentTrace 行（模拟历史文件）
    const today = new Date().toISOString().slice(0, 10)
    const legacy = {
      trace_id: 'legacy-1', spans: [], status: 'completed', started_at: new Date().toISOString(),
      related_task_id: 'task-9', trigger: { type: 'task', summary: 'x' },
    }
    fs.writeFileSync(path.join(dir, `traces-v3-${today}.jsonl`), JSON.stringify(legacy) + '\n', 'utf-8')
    store.startManagerEpisode('ep-6', KEY_A, TRIGGER)

    const rebuilt = new TraceStore(100, dir, 'traces-running.jsonl', 'traces-v3-')
    // legacy 行仍可读且进 legacy 索引
    await expect(rebuilt.getFullTrace('legacy-1')).resolves.toBeDefined()
    // manager record 不进 legacy task/trace 面
    await expect(rebuilt.getFullTrace('ep-6')).resolves.toBeUndefined()
    rebuilt.stopFlushTimer()
  })

  it('manager index is isolated per manager_key with stable sort and pagination', () => {
    for (let i = 0; i < 25; i++) store.startManagerEpisode(`ep-a-${String(i).padStart(2, '0')}`, KEY_A, TRIGGER)
    store.startManagerEpisode('ep-b-1', KEY_B, TRIGGER)
    expect(store.countManagerEpisodes(KEY_A)).toBe(25)
    expect(store.countManagerEpisodes(KEY_B)).toBe(1)

    const page1 = store.listManagerEpisodes(KEY_A, { page: 1, page_size: 10 })
    expect(page1.items).toHaveLength(10)
    expect(page1.pagination).toMatchObject({ page: 1, page_size: 10, total_items: 25, total_pages: 3 })
    // started_at desc, trace_id asc 稳定排序（按性质断言，同毫秒批量创建时仍稳定）
    const sorted = [...page1.items].sort((left, right) => {
      const byStartedDesc = right.started_at.localeCompare(left.started_at)
      return byStartedDesc !== 0 ? byStartedDesc : left.trace_id.localeCompare(right.trace_id)
    })
    expect(page1.items.map((item) => item.trace_id)).toEqual(sorted.map((item) => item.trace_id))
    const page3 = store.listManagerEpisodes(KEY_A, { page: 3, page_size: 10 })
    expect(page3.items).toHaveLength(5)
    expect(store.listManagerEpisodes(KEY_B, { page: 1, page_size: 20 }).items[0].trace_id).toBe('ep-b-1')
    // 缺省/脏分页归一
    const dirty = store.listManagerEpisodes(KEY_A, { page: 0, page_size: 99999 })
    expect(dirty.pagination.page).toBe(1)
    expect(dirty.pagination.page_size).toBe(100)
  })

  it('start persistence failure throws (episode admission fail-closed)', () => {
    fs.chmodSync(dir, 0o500)
    try {
      expect(() => store.startManagerEpisode('ep-ro', KEY_A, TRIGGER)).toThrow('persistence failed')
      expect(store.getManagerEpisode('ep-ro')).toBeUndefined()
    } finally {
      fs.chmodSync(dir, 0o700)
    }
  })

  it('sensitive fixture values never hit the disk', () => {
    const secretTrigger: ManagerEpisodeTrigger = {
      type: 'human_message',
      summary: 'Bearer sk-supersecretvalue123456789',
      source: 'admin',
    }
    // 调用方负责脱敏（UnifiedAgent 包 redactSecrets）；这里验证 TraceStore 原样落盘
    // 的内容是调用方给的脱敏结果——所以用已脱敏输入断言。
    const redacted = { ...secretTrigger, summary: 'Bearer [REDACTED]' }
    store.startManagerEpisode('ep-secret', KEY_A, redacted)
    const today = new Date().toISOString().slice(0, 10)
    const archive = fs.readFileSync(path.join(dir, `traces-v3-${today}.jsonl`), 'utf-8')
    expect(archive).not.toContain('sk-supersecretvalue123456789')
    expect(archive).toContain('[REDACTED]')
  })

  it('bad manager records are isolated and reported without breaking legacy index', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const legacy = {
      trace_id: 'legacy-2', spans: [], status: 'completed', started_at: new Date().toISOString(),
      related_task_id: 'task-1', trigger: { type: 'task', summary: 'x' },
    }
    const badManager = { kind: 'manager_episode', trace: { trace_id: '', manager_key: '' } }
    fs.writeFileSync(
      path.join(dir, `traces-v3-${today}.jsonl`),
      JSON.stringify(badManager) + '\n' + JSON.stringify(legacy) + '\n',
      'utf-8',
    )
    const rebuilt = new TraceStore(100, dir, 'traces-running.jsonl', 'traces-v3-')
    await expect(rebuilt.getFullTrace('legacy-2')).resolves.toBeDefined()
    expect(rebuilt.getManagerBadRecordCount()).toBeGreaterThan(0)
    rebuilt.stopFlushTimer()
  })

  it('cleanup by date removes manager records from files but never running episodes', () => {
    // 构造一条老日期的 manager record
    const old = new Date()
    old.setDate(old.getDate() - 40)
    const oldFile = `traces-v3-${old.toISOString().slice(0, 10)}.jsonl`
    const oldEpisode = {
      kind: 'manager_episode',
      trace: {
        trace_id: 'ep-old', manager_key: KEY_A, started_at: old.toISOString(), status: 'completed',
        trigger: TRIGGER, spans: [], spawned_worker_ids: [],
      },
    }
    fs.writeFileSync(path.join(dir, oldFile), JSON.stringify(oldEpisode) + '\n', 'utf-8')
    store.startManagerEpisode('ep-running', KEY_A, TRIGGER)

    const rebuilt = new TraceStore(100, dir, 'traces-running.jsonl', 'traces-v3-')
    expect(rebuilt.countManagerEpisodes(KEY_A)).toBe(2)
    const result = rebuilt.cleanupOldTraces(30, false)
    expect(result.affected_count).toBe(1)
    expect(rebuilt.getManagerEpisode('ep-old')).toBeUndefined()
    expect(rebuilt.getManagerEpisode('ep-running')).toBeDefined()
    rebuilt.stopFlushTimer()
  })
})
