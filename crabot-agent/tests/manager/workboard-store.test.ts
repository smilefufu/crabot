import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  ManagerWorkboardStore,
  type WorkboardItemDraft,
} from '../../src/manager/workboard-store.js'
import { encodeSegment } from '../../src/workers/harness/ledger-store.js'
import type { ManagerKey } from '../../src/manager/types.js'

const KEY = 'feishu::cotton-candy' as ManagerKey
const OTHER_KEY = 'feishu::other' as ManagerKey

function draft(title: string, overrides: Partial<WorkboardItemDraft> = {}): WorkboardItemDraft {
  return {
    title,
    status: 'ready',
    objective: `完成 ${title}`,
    acceptance: ['结果经过验证'],
    current_state: '需求已确认',
    next_action: '开始执行',
    blockers: [],
    ...overrides,
  }
}

describe('ManagerWorkboardStore', () => {
  let root: string
  let nowIndex: number
  let store: ManagerWorkboardStore

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'manager-workboard-'))
    nowIndex = 0
    store = new ManagerWorkboardStore(root, () =>
      new Date(Date.parse('2026-09-04T00:00:00.000Z') + nowIndex++ * 1_000).toISOString(),
    )
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('缺文件返回一张空板且不产生目录', async () => {
    await expect(store.load(KEY)).resolves.toEqual({
      schema_version: 1,
      manager_key: KEY,
      active: [],
      archive: [],
    })
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('同一会话可同时创建多个任务项，不同会话相互隔离', async () => {
    await store.create(KEY, draft('核查主控上下文混乱'))
    await store.create(KEY, draft('设计隔离回归环境'))
    await store.create(OTHER_KEY, draft('另一个会话的任务'))

    expect((await store.load(KEY)).active.map((item) => item.title)).toEqual([
      '核查主控上下文混乱',
      '设计隔离回归环境',
    ])
    expect((await store.load(OTHER_KEY)).active.map((item) => item.title)).toEqual([
      '另一个会话的任务',
    ])
  })

  it('revise 完整替换当前快照，archive 原子移动最终快照', async () => {
    await store.create(KEY, draft('核查主控上下文混乱'))
    const revised = await store.revise(
      KEY,
      '核查主控上下文混乱',
      draft('核查主控上下文混乱', {
        status: 'blocked',
        objective: '还原每一次真实请求',
        acceptance: ['定位请求数据中的根因', '形成回归样例'],
        current_state: '缺少一段原始时间线',
        next_action: '取得脱敏时间线',
        blockers: ['等待脱敏数据'],
      }),
    )

    expect(revised.item).toMatchObject({
      status: 'blocked',
      objective: '还原每一次真实请求',
      blockers: ['等待脱敏数据'],
    })
    expect(revised.item.updated_at).not.toBe('2026-09-04T00:00:00.000Z')

    const archived = await store.archive(KEY, '核查主控上下文混乱', 'abandoned')
    expect(archived.board.active).toEqual([])
    expect(archived.board.archive).toHaveLength(1)
    expect(archived.item).toMatchObject({
      title: '核查主控上下文混乱',
      archived_as: 'abandoned',
      archived_at: expect.any(String),
    })
  })

  it('拒绝同标题、含糊空白正文、非法 blocked 和超大任务项', async () => {
    await store.create(KEY, draft('任务甲'))
    await expect(store.create(KEY, draft(' 任务甲 '))).rejects.toThrow(/重复|标题/)
    await expect(store.create(KEY, draft('任务乙', { objective: '   ' }))).rejects.toThrow(/objective/)
    await expect(store.create(KEY, draft('任务丙', { status: 'blocked', blockers: [] }))).rejects.toThrow(/blocker/)
    await expect(store.create(KEY, draft('任务丁', { current_state: 'x'.repeat(40_000) }))).rejects.toThrow(/32 KiB/)
  })

  it('project_root 必须是规范化绝对路径', async () => {
    await expect(store.create(KEY, draft('任务甲', { project_root: './relative' }))).rejects.toThrow(/project_root/)
    await expect(store.create(KEY, draft('任务乙', { project_root: '/tmp/a/../b' }))).rejects.toThrow(/project_root/)
  })

  it('坏 JSON、错误 manager_key、未知版本和非法字段都 fail-loud', async () => {
    const dir = join(root, encodeSegment(KEY))
    const path = join(dir, 'workboard.json')
    await fs.mkdir(dir, { recursive: true })

    await fs.writeFile(path, '{ bad json', 'utf-8')
    await expect(store.load(KEY)).rejects.toThrow(/JSON|损坏/)

    await fs.writeFile(path, JSON.stringify({ schema_version: 1, manager_key: OTHER_KEY, active: [], archive: [] }))
    await expect(store.load(KEY)).rejects.toThrow(/manager_key/)

    await fs.writeFile(path, JSON.stringify({ schema_version: 2, manager_key: KEY, active: [], archive: [] }))
    await expect(store.load(KEY)).rejects.toThrow(/schema_version/)

    await fs.writeFile(path, JSON.stringify({ schema_version: 1, manager_key: KEY, active: [], archive: [], id: 'nope' }))
    await expect(store.load(KEY)).rejects.toThrow(/字段|shape/)
  })

  it('并发 create 经过同一读改写锁，不丢任务项', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      store.create(KEY, draft(`并发任务 ${index}`)),
    ))

    const board = await store.load(KEY)
    expect(board.active).toHaveLength(12)
    expect(new Set(board.active.map((item) => item.title)).size).toBe(12)
  })
})
