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

    await fs.writeFile(path, JSON.stringify({ schema_version: 3, manager_key: KEY, active: [], archive: [] }))
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

  it('v1 只读投影为 revision 0，首次写入才原子升级为 v2', async () => {
    const dir = join(root, encodeSegment(KEY))
    const file = join(dir, 'workboard.json')
    const legacy = {
      schema_version: 1,
      manager_key: KEY,
      active: [{ ...draft('旧任务'), updated_at: '2026-09-04T00:00:00.000Z' }],
      archive: [],
    }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, JSON.stringify(legacy), 'utf-8')

    await expect(store.loadAdmin(KEY)).resolves.toMatchObject({ revision: 0, active: [{ title: '旧任务' }] })
    await expect(fs.readFile(file, 'utf-8')).resolves.toBe(JSON.stringify(legacy))

    await store.revise(KEY, '旧任务', draft('旧任务', { current_state: '已更新' }))
    await expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toMatchObject({ schema_version: 2, revision: 1 })
  })

  it('Admin CAS、同项 read fence 与 notice 都在同一原子写入边界', async () => {
    await store.create(KEY, draft('核查上下文'))
    const admin = await store.adminRevise(KEY, 1, '核查上下文', draft('核查上下文', { current_state: '管理员已修订' }))
    expect(admin.board.revision).toBe(2)
    expect(admin.notice).toMatchObject({ revision: 2, attempts: 0 })
    expect(admin.notice).not.toHaveProperty('principal_permissions')
    await expect(store.adminCreate(KEY, 1, draft('旧表单'))).rejects.toMatchObject({
      code: 'WORKBOARD_REVISION_CONFLICT', currentRevision: 2,
    })
    await expect(store.revise(KEY, '核查上下文', draft('核查上下文'))).rejects.toThrow('请先使用 inspect_workboard')

    const visible = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', visible.active, visible.revision)
    await expect(store.revise(KEY, '核查上下文', draft('核查上下文', { next_action: '按新要求执行' }))).resolves.toMatchObject({
      board: { active: [{ next_action: '按新要求执行' }] },
    })
    expect((await store.loadAdmin(KEY)).revision).toBe(3)
    // notice 指向最近一次 Admin 保存；Manager 后续写入可以推进整板 revision，
    // 但不能把未消费的系统管理输入误判为损坏或由其它 revision 清除。
    await expect(store.pendingAdminNotice(KEY)).resolves.toMatchObject({ revision: 2 })
    await expect(store.clearAdminNoticeIfCurrent(KEY, 3)).resolves.toBe(false)
    await expect(store.clearAdminNoticeIfCurrent(KEY, 2)).resolves.toBe(true)
  })

  it('改标题和归档保留同一事项的标题别名，另一事项的 fence 不被覆盖', async () => {
    await store.create(KEY, draft('任务甲'))
    await store.create(KEY, draft('任务乙'))
    await store.adminRevise(KEY, 2, '任务甲', draft('任务甲新版'))
    await store.adminArchive(KEY, 3, '任务甲新版', 'completed')
    await store.adminRevise(KEY, 4, '任务乙', draft('任务乙', { current_state: '管理员更新' }))

    await expect(store.create(KEY, draft('任务甲'))).rejects.toThrow('请先使用 inspect_workboard')
    await expect(store.revise(KEY, '任务乙', draft('任务乙'))).rejects.toThrow('请先使用 inspect_workboard')
    const archive = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'archive', archive.archive, archive.revision)
    await expect(store.create(KEY, draft('任务甲'))).resolves.toBeDefined()
    await expect(store.revise(KEY, '任务乙', draft('任务乙'))).rejects.toThrow('请先使用 inspect_workboard')
  })

  it('旧的 inspect 快照不能确认之后同一事项的 Admin 更新', async () => {
    await store.create(KEY, draft('核查上下文'))
    await store.adminRevise(KEY, 1, '核查上下文', draft('核查上下文', { current_state: '管理员第一次更新' }))
    const stale = await store.loadAdmin(KEY)
    await store.adminRevise(KEY, 2, '核查上下文', draft('核查上下文', { current_state: '管理员第二次更新' }))

    await store.acknowledgeManagerRead(KEY, 'active', stale.active, stale.revision)
    await expect(store.revise(KEY, '核查上下文', draft('核查上下文'))).rejects.toThrow('请先使用 inspect_workboard')

    const current = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', current.active, current.revision)
    await expect(store.revise(KEY, '核查上下文', draft('核查上下文', { next_action: '按最新要求执行' }))).resolves.toBeDefined()
  })

  it('读取旧 notice 的权限残留但正常任务板写入会删除它', async () => {
    const directory = join(root, encodeSegment(KEY))
    const file = join(directory, 'workboard.json')
    const legacyNotice = {
      schema_version: 2,
      manager_key: KEY,
      revision: 1,
      active: [{ ...draft('旧任务'), updated_at: '2026-09-04T00:00:00.000Z' }],
      archive: [],
      pending_admin_notice: {
        revision: 1,
        created_at: '2026-09-04T00:00:00.000Z',
        principal_permissions: { obsolete: true },
        attempts: 0,
      },
    }
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(file, JSON.stringify(legacyNotice), 'utf8')

    await expect(store.pendingAdminNotice(KEY)).resolves.toMatchObject({ revision: 1, attempts: 0 })
    await store.revise(KEY, '旧任务', draft('旧任务', { current_state: '已经续办' }))
    expect(await fs.readFile(file, 'utf8')).not.toContain('principal_permissions')
  })
})
