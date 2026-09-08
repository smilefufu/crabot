import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  ManagerWorkboardStore,
  type WorkboardItem,
  type WorkboardItemDraft,
  type WorkboardObjective,
  type WorkboardObjectiveDraft,
} from '../../src/manager/workboard-store.js'
import { encodeSegment } from '../../src/workers/harness/ledger-store.js'
import type { ManagerKey } from '../../src/manager/types.js'

const KEY = 'feishu::cotton-candy' as ManagerKey
const OTHER_KEY = 'feishu::other' as ManagerKey
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OBJECTIVE_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_OBJECTIVE_ID = '00000000-0000-4000-8000-000000000002'
const WORK_ITEM_ID = '00000000-0000-4000-8000-000000000003'
const TIMESTAMP = '2026-09-06T00:00:00.000Z'

function objective(title: string, completionCriteria = [`${title} 的结果可核对`]): WorkboardObjectiveDraft {
  return { title, completion_criteria: completionCriteria }
}

function item(title: string, overrides: Partial<WorkboardItemDraft> = {}): WorkboardItemDraft {
  return {
    title,
    status: 'ready',
    next_action: '开始推进',
    ...overrides,
  }
}

function persistedObjective(
  objectiveId = OBJECTIVE_ID,
  title = '目标甲',
  workItems: unknown[] = [],
): Record<string, unknown> {
  return {
    objective_id: objectiveId,
    title,
    completion_criteria: [`${title} 的结果可核对`],
    work_items: workItems,
    updated_at: TIMESTAMP,
  }
}

function persistedItem(workItemId = WORK_ITEM_ID, title = '事项甲'): Record<string, unknown> {
  return {
    work_item_id: workItemId,
    title,
    status: 'ready',
    next_action: '开始推进',
    updated_at: TIMESTAMP,
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
      new Date(Date.parse(TIMESTAMP) + nowIndex++ * 1_000).toISOString(),
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  async function createObjective(title: string, completionCriteria?: string[]): Promise<WorkboardObjective> {
    return (await store.createObjective(KEY, objective(title, completionCriteria))).value
  }

  async function createWorkItem(
    objectiveId: string,
    title: string,
    overrides: Partial<WorkboardItemDraft> = {},
  ): Promise<WorkboardItem> {
    return (await store.createWorkItem(KEY, objectiveId, item(title, overrides))).value
  }

  it('缺文件返回一张空板且不产生目录', async () => {
    await expect(store.load(KEY)).resolves.toEqual({
      manager_key: KEY,
      objectives: [],
      archive: [],
    })
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('同一会话支持多目标多事项，不同会话相互隔离', async () => {
    const first = await createObjective('恢复会话记忆一致性')
    await createObjective('建立隔离回归环境')
    await createWorkItem(first.objective_id, '核查请求链路')
    await createWorkItem(first.objective_id, '验证压缩后回顾')
    await store.createObjective(OTHER_KEY, objective('另一个会话的目标'))

    const board = await store.load(KEY)
    expect(board.objectives.map((entry) => entry.title)).toEqual([
      '恢复会话记忆一致性',
      '建立隔离回归环境',
    ])
    expect(board.objectives[0].work_items.map((entry) => entry.title)).toEqual([
      '核查请求链路',
      '验证压缩后回顾',
    ])
    expect((await store.load(OTHER_KEY)).objectives).toHaveLength(1)
  })

  it('稳定内部 ID 在目标改名、事项修订和跨目标移动后保持不变', async () => {
    const first = await createObjective('目标甲')
    const second = await createObjective('目标乙')
    expect(first.objective_id).toMatch(UUID)
    expect(second.objective_id).toMatch(UUID)

    const created = await createWorkItem(first.objective_id, '核查上下文')
    expect(created.work_item_id).toMatch(UUID)

    const revisedObjective = await store.reviseObjective(KEY, first.objective_id, objective('目标甲新版'))
    expect(revisedObjective.value.objective_id).toBe(first.objective_id)
    const revised = await store.reviseWorkItem(
      KEY,
      created.work_item_id,
      undefined,
      item('核查上下文新版', { next_action: '继续核查' }),
    )
    expect(revised.value).toMatchObject({ work_item_id: created.work_item_id, title: '核查上下文新版' })

    const moved = await store.reviseWorkItem(
      KEY,
      created.work_item_id,
      second.objective_id,
      item('核查上下文新版', { next_action: '在目标乙继续核查' }),
    )
    expect(moved.value.work_item_id).toBe(created.work_item_id)
    expect(moved.board.objectives.find((entry) => entry.objective_id === second.objective_id)?.work_items)
      .toMatchObject([{ work_item_id: created.work_item_id }])
  })

  it('修订目标保留事项，事项可原地修订或原子移动到另一目标', async () => {
    const first = await createObjective('目标甲')
    const second = await createObjective('目标乙')
    const created = await createWorkItem(first.objective_id, '核查上下文')
    const itemUpdatedAt = created.updated_at

    const revisedObjective = await store.reviseObjective(
      KEY,
      first.objective_id,
      objective('目标甲新版', ['条件一', '条件二']),
    )
    expect(revisedObjective.value).toMatchObject({
      objective_id: first.objective_id,
      title: '目标甲新版',
      completion_criteria: ['条件一', '条件二'],
      work_items: [{ work_item_id: created.work_item_id, title: '核查上下文', updated_at: itemUpdatedAt }],
    })

    const revisedItem = await store.reviseWorkItem(
      KEY,
      created.work_item_id,
      undefined,
      item('核查上下文', {
        status: 'in_progress',
        current_judgement: '已确认历史输入有缺口',
        next_action: '判断缺口是否影响结论',
      }),
    )
    expect(revisedItem.value).toMatchObject({
      work_item_id: created.work_item_id,
      status: 'in_progress',
      current_judgement: '已确认历史输入有缺口',
    })

    const moved = await store.reviseWorkItem(
      KEY,
      created.work_item_id,
      second.objective_id,
      item('核查请求链路', { next_action: '在新目标下继续核查' }),
    )
    expect(moved.value).toMatchObject({ work_item_id: created.work_item_id, title: '核查请求链路' })
    expect(moved.board.objectives.find((entry) => entry.objective_id === first.objective_id)?.work_items).toEqual([])
    expect(moved.board.objectives.find((entry) => entry.objective_id === second.objective_id)?.work_items).toMatchObject([
      { work_item_id: created.work_item_id, title: '核查请求链路' },
    ])
  })

  it('事项和目标归档保留 ID，目标只有为空时才能归档', async () => {
    const createdObjective = await createObjective('恢复会话记忆一致性', ['回顾前后一致'])
    const createdItem = await createWorkItem(createdObjective.objective_id, '核查请求链路')

    await expect(store.archiveObjective(KEY, createdObjective.objective_id, 'completed')).rejects.toThrow(/仍有当前事项/)
    const archivedItem = await store.archiveWorkItem(KEY, createdItem.work_item_id, 'completed')
    expect(archivedItem.value).toMatchObject({
      work_item_id: createdItem.work_item_id,
      title: '核查请求链路',
      objective: { title: '恢复会话记忆一致性', completion_criteria: ['回顾前后一致'] },
      archived_as: 'completed',
    })

    const archivedObjective = await store.archiveObjective(KEY, createdObjective.objective_id, 'completed')
    expect(archivedObjective.value.objective_id).toBe(createdObjective.objective_id)
    expect(archivedObjective.board.objectives).toEqual([])
    expect(archivedObjective.board.archive).toMatchObject([
      { work_item_id: createdItem.work_item_id, title: '核查请求链路', archived_as: 'completed' },
      { objective_id: createdObjective.objective_id, title: '恢复会话记忆一致性', archived_as: 'completed' },
    ])
  })

  it('校验两级标题、完成条件、状态字段、大小与项目根目录', async () => {
    const first = await createObjective('目标甲')
    const second = await createObjective('目标乙')
    await expect(store.createObjective(KEY, objective(' 目标甲 '))).rejects.toThrow(/重复|标题/)
    await expect(store.createObjective(KEY, objective('目标丙', []))).rejects.toThrow(/completion_criteria/)
    await expect(store.createObjective(KEY, objective('目标丁', ['1', '2', '3', '4', '5', '6']))).rejects.toThrow(/1 至 5/)

    await createWorkItem(first.objective_id, '同名事项')
    await createWorkItem(second.objective_id, '同名事项')
    await expect(createWorkItem(first.objective_id, ' 同名事项 ')).rejects.toThrow(/重复|标题/)
    await expect(createWorkItem(first.objective_id, '非法进行中', { status: 'in_progress' })).rejects.toThrow(/current_judgement/)
    await expect(createWorkItem(first.objective_id, '非法阻塞', {
      status: 'blocked', current_judgement: '等待条件',
    })).rejects.toThrow(/blocker/)
    await expect(createWorkItem(first.objective_id, '非法待开始', { blocker: '不应存在' })).rejects.toThrow(/blocker/)
    await expect(createWorkItem(first.objective_id, '相对路径', { project_root: './relative' })).rejects.toThrow(/project_root/)
    await expect(createWorkItem(first.objective_id, '未规范路径', { project_root: '/tmp/a/../b' })).rejects.toThrow(/project_root/)
    await expect(createWorkItem(first.objective_id, '超大事项', { next_action: 'x'.repeat(40_000) })).rejects.toThrow(/32 KiB/)
    await expect(store.createWorkItem(KEY, '目标甲', item('旧标题参数'))).rejects.toThrow(/objective_id/)
  })

  it('坏 JSON、错误 manager_key、未知版本和非法字段都 fail-loud', async () => {
    const dir = join(root, encodeSegment(KEY))
    const file = join(dir, 'workboard.json')
    await fs.mkdir(dir, { recursive: true })

    await fs.writeFile(file, '{ bad json', 'utf-8')
    await expect(store.load(KEY)).rejects.toThrow(/JSON|损坏/)

    await fs.writeFile(file, JSON.stringify({ schema_version: 4, manager_key: OTHER_KEY, revision: 0, objectives: [], archive: [] }))
    await expect(store.load(KEY)).rejects.toThrow(/manager_key/)

    await fs.writeFile(file, JSON.stringify({ schema_version: 2, manager_key: KEY, revision: 0, objectives: [], archive: [] }))
    await expect(store.load(KEY)).rejects.toThrow(/schema_version/)

    await fs.writeFile(file, JSON.stringify({ schema_version: 4, manager_key: KEY, revision: 0, objectives: [], archive: [], id: 'nope' }))
    await expect(store.load(KEY)).rejects.toThrow(/字段|shape/)
  })

  it('首次读取将完整 schema v3 原子迁移为 v4，保留 revision、notice 并按 fence 最后位置映射 ID', async () => {
    const dir = join(root, encodeSegment(KEY))
    const file = join(dir, 'workboard.json')
    const notice = {
      revision: 9,
      created_at: TIMESTAMP,
      attempts: 2,
      retry_after_at: '2026-09-06T01:00:00.000Z',
    }
    const legacy = {
      schema_version: 3,
      manager_key: KEY,
      revision: 9,
      objectives: [{
        title: '当前目标',
        completion_criteria: ['当前目标完成'],
        work_items: [{
          title: '当前事项',
          status: 'in_progress',
          current_judgement: '正在核对',
          next_action: '完成核对',
          updated_at: TIMESTAMP,
        }],
        updated_at: TIMESTAMP,
      }],
      archive: [{
        title: '归档事项',
        status: 'ready',
        next_action: '无需继续',
        updated_at: TIMESTAMP,
        objective: { title: '事项原目标', completion_criteria: ['原目标完成'] },
        archived_as: 'completed',
        archived_at: TIMESTAMP,
      }, {
        title: '归档目标',
        completion_criteria: ['归档目标完成'],
        archived_as: 'abandoned',
        archived_at: TIMESTAMP,
      }],
      pending_admin_notice: notice,
      admin_read_fences: [{
        revision: 6,
        view: 'active',
        locations: [{ objective_title: '当前目标旧名' }, { objective_title: '当前目标' }],
      }, {
        revision: 7,
        view: 'active',
        locations: [
          { objective_title: '当前目标', work_item_title: '当前事项旧名' },
          { objective_title: '当前目标', work_item_title: '当前事项' },
        ],
      }, {
        revision: 8,
        view: 'archive',
        locations: [{ objective_title: '事项原目标', work_item_title: '归档事项' }],
      }, {
        revision: 9,
        view: 'archive',
        locations: [{ objective_title: '归档目标' }],
      }],
    }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, JSON.stringify(legacy, null, 2), 'utf-8')

    const first = await store.loadAdmin(KEY)
    const firstRaw = await fs.readFile(file, 'utf-8')
    const persisted = JSON.parse(firstRaw)
    const objectiveId = persisted.objectives[0].objective_id
    const workItemId = persisted.objectives[0].work_items[0].work_item_id
    const archivedWorkItemId = persisted.archive[0].work_item_id
    const archivedObjectiveId = persisted.archive[1].objective_id

    expect(first).toMatchObject({
      manager_key: KEY,
      revision: 9,
      objectives: [{ objective_id: objectiveId, work_items: [{ work_item_id: workItemId }] }],
      archive: [{ work_item_id: archivedWorkItemId }, { objective_id: archivedObjectiveId }],
    })
    expect([objectiveId, workItemId, archivedWorkItemId, archivedObjectiveId]).toEqual([
      expect.stringMatching(UUID),
      expect.stringMatching(UUID),
      expect.stringMatching(UUID),
      expect.stringMatching(UUID),
    ])
    expect(new Set([objectiveId, archivedObjectiveId]).size).toBe(2)
    expect(new Set([workItemId, archivedWorkItemId]).size).toBe(2)
    expect(persisted).toMatchObject({
      schema_version: 4,
      revision: 9,
      pending_admin_notice: notice,
      admin_read_fences: [
        { revision: 6, view: 'active', location: { objective_id: objectiveId } },
        { revision: 7, view: 'active', location: { work_item_id: workItemId } },
        { revision: 8, view: 'archive', location: { work_item_id: archivedWorkItemId } },
        { revision: 9, view: 'archive', location: { objective_id: archivedObjectiveId } },
      ],
    })

    await expect(store.loadAdmin(KEY)).resolves.toEqual(first)
    await expect(fs.readFile(file, 'utf-8')).resolves.toBe(firstRaw)
  })

  it.each([
    {
      name: '非法内容',
      board: {
        schema_version: 3,
        manager_key: KEY,
        revision: 0,
        objectives: [{
          title: '目标甲',
          completion_criteria: ['目标完成'],
          work_items: [{ title: '事项甲', status: 'unknown', next_action: '继续', updated_at: TIMESTAMP }],
          updated_at: TIMESTAMP,
        }],
        archive: [],
      },
      error: /status/,
    },
    {
      name: '归档 fence 位置歧义',
      board: {
        schema_version: 3,
        manager_key: KEY,
        revision: 2,
        objectives: [],
        archive: [{
          title: '同名目标',
          completion_criteria: ['第一次完成'],
          archived_as: 'completed',
          archived_at: TIMESTAMP,
        }, {
          title: '同名目标',
          completion_criteria: ['第二次完成'],
          archived_as: 'abandoned',
          archived_at: TIMESTAMP,
        }],
        admin_read_fences: [{
          revision: 2,
          view: 'archive',
          locations: [{ objective_title: '同名目标' }],
        }],
      },
      error: /无法唯一映射/,
    },
  ])('$name 时 fail-loud 且原文件字节不变', async ({ board, error }) => {
    const dir = join(root, encodeSegment(KEY))
    const file = join(dir, 'workboard.json')
    const original = JSON.stringify(board, null, 2)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, original, 'utf-8')

    await expect(store.load(KEY)).rejects.toThrow(error)
    await expect(fs.readFile(file, 'utf-8')).resolves.toBe(original)
  })

  it('schema v3 迁移写回失败时保留原文件并清理临时文件', async () => {
    const dir = join(root, encodeSegment(KEY))
    const file = join(dir, 'workboard.json')
    const original = JSON.stringify({
      schema_version: 3,
      manager_key: KEY,
      revision: 0,
      objectives: [],
      archive: [],
    }, null, 2)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, original, 'utf-8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('模拟 rename 失败'))

    await expect(store.load(KEY)).rejects.toThrow(/迁移写回失败/)
    await expect(fs.readFile(file, 'utf-8')).resolves.toBe(original)
    await expect(fs.readdir(dir)).resolves.toEqual(['workboard.json'])
  })

  it('缺失、非法或同类型重复 ID 的 schema v4 数据 fail-loud', async () => {
    const dir = join(root, encodeSegment(KEY))
    const file = join(dir, 'workboard.json')
    await fs.mkdir(dir, { recursive: true })
    const writeBoard = (objectives: unknown[], archive: unknown[] = []) => fs.writeFile(file, JSON.stringify({
      schema_version: 4,
      manager_key: KEY,
      revision: 0,
      objectives,
      archive,
    }))

    const missingId = persistedObjective()
    delete missingId.objective_id
    await writeBoard([missingId])
    await expect(store.load(KEY)).rejects.toThrow(/objective_id/)

    await writeBoard([persistedObjective('not-an-id')])
    await expect(store.load(KEY)).rejects.toThrow(/objective_id/)

    await writeBoard([
      persistedObjective(OBJECTIVE_ID, '目标甲'),
      persistedObjective(OBJECTIVE_ID, '目标乙'),
    ])
    await expect(store.load(KEY)).rejects.toThrow(/objective_id 重复/)

    await writeBoard([
      persistedObjective(OBJECTIVE_ID, '目标甲', [persistedItem(WORK_ITEM_ID, '事项甲')]),
      persistedObjective(OTHER_OBJECTIVE_ID, '目标乙', [persistedItem(WORK_ITEM_ID, '事项乙')]),
    ])
    await expect(store.load(KEY)).rejects.toThrow(/work_item_id 重复/)
  })

  it('并发创建事项经过同一读改写锁且不丢数据', async () => {
    const createdObjective = await createObjective('并发目标')
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      createWorkItem(createdObjective.objective_id, `并发事项 ${index}`),
    ))

    const items = (await store.load(KEY)).objectives[0].work_items
    expect(items).toHaveLength(12)
    expect(new Set(items.map((entry) => entry.title)).size).toBe(12)
    expect(new Set(items.map((entry) => entry.work_item_id)).size).toBe(12)
  })

  it('Admin 目标 fence 阻止目标及其事项修改，读取完整目标后解除', async () => {
    const createdObjective = await createObjective('目标甲')
    const createdItem = await createWorkItem(createdObjective.objective_id, '事项甲')
    const admin = await store.adminReviseObjective(KEY, 2, createdObjective.objective_id, objective('目标甲新版'))
    expect(admin.board.revision).toBe(3)
    expect(admin.notice).toMatchObject({ revision: 3, attempts: 0 })

    await expect(store.reviseObjective(KEY, createdObjective.objective_id, objective('目标甲最终版'))).rejects.toThrow('请先使用 inspect_workboard')
    await expect(createWorkItem(createdObjective.objective_id, '事项乙')).rejects.toThrow('请先使用 inspect_workboard')
    await expect(store.reviseWorkItem(KEY, createdItem.work_item_id, undefined, item('事项甲'))).rejects.toThrow('请先使用 inspect_workboard')

    const visible = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', visible.objectives, visible.revision)
    await expect(createWorkItem(createdObjective.objective_id, '事项乙')).resolves.toBeDefined()
  })

  it('Admin 事项 fence 只阻止同一事项，且旧读取不能确认后续更新', async () => {
    const createdObjective = await createObjective('目标甲')
    const first = await createWorkItem(createdObjective.objective_id, '事项甲')
    const second = await createWorkItem(createdObjective.objective_id, '事项乙')
    await store.adminReviseWorkItem(KEY, 3, first.work_item_id, undefined, item('事项甲', {
      status: 'in_progress', current_judgement: '管理员第一次更新', next_action: '继续核对',
    }))
    const stale = await store.loadAdmin(KEY)
    await store.adminReviseWorkItem(KEY, 4, first.work_item_id, undefined, item('事项甲', {
      status: 'in_progress', current_judgement: '管理员第二次更新', next_action: '按新判断推进',
    }))

    await expect(store.reviseWorkItem(KEY, second.work_item_id, undefined, item('事项乙', { next_action: '独立推进' }))).resolves.toBeDefined()
    await store.acknowledgeManagerRead(KEY, 'active', stale.objectives, stale.revision)
    await expect(store.reviseWorkItem(KEY, first.work_item_id, undefined, item('事项甲'))).rejects.toThrow('请先使用 inspect_workboard')

    const current = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', current.objectives, current.revision)
    await expect(store.reviseWorkItem(KEY, first.work_item_id, undefined, item('事项甲', { next_action: '按最新要求执行' }))).resolves.toBeDefined()
  })

  it('Admin 跨目标移动后由同一事项 ID 的 fence 保护，读取迁入目标后解除', async () => {
    const source = await createObjective('来源目标')
    const target = await createObjective('迁入目标')
    const movedItem = await createWorkItem(source.objective_id, '旧事项')
    const admin = await store.adminReviseWorkItem(
      KEY,
      3,
      movedItem.work_item_id,
      target.objective_id,
      item('新事项'),
    )
    expect(admin.value.work_item_id).toBe(movedItem.work_item_id)

    await expect(createWorkItem(source.objective_id, '旧事项')).resolves.toBeDefined()
    await expect(store.reviseWorkItem(KEY, movedItem.work_item_id, undefined, item('新事项'))).rejects.toThrow('请先使用 inspect_workboard')

    const visible = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(
      KEY,
      'active',
      visible.objectives.filter((entry) => entry.objective_id === target.objective_id),
      visible.revision,
    )
    await expect(store.reviseWorkItem(KEY, movedItem.work_item_id, undefined, item('新事项'))).resolves.toBeDefined()
  })

  it('同名事项由不同 ID 的 read fence 分别确认', async () => {
    const source = await createObjective('来源目标')
    const target = await createObjective('迁入目标')
    const movedItem = await createWorkItem(source.objective_id, '同名事项')
    await store.adminReviseWorkItem(KEY, 3, movedItem.work_item_id, target.objective_id, item('同名事项'))
    const newItem = (await store.adminCreateWorkItem(KEY, 4, source.objective_id, item('同名事项', {
      next_action: '推进新事项',
    }))).value

    const current = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(
      KEY,
      'active',
      current.objectives.filter((entry) => entry.objective_id === target.objective_id),
      current.revision,
    )
    await expect(store.reviseWorkItem(
      KEY,
      movedItem.work_item_id,
      undefined,
      item('同名事项', { next_action: '继续迁入事项' }),
    )).resolves.toBeDefined()
    await expect(store.reviseWorkItem(
      KEY,
      newItem.work_item_id,
      undefined,
      item('同名事项', { next_action: '继续新事项' }),
    )).rejects.toThrow('请先使用 inspect_workboard')

    const refreshed = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(
      KEY,
      'active',
      refreshed.objectives.filter((entry) => entry.objective_id === source.objective_id),
      refreshed.revision,
    )
    await expect(store.reviseWorkItem(
      KEY,
      newItem.work_item_id,
      undefined,
      item('同名事项', { next_action: '已核对后继续' }),
    )).resolves.toBeDefined()
  })

  it('目标改名后新建同名目标仍由不同 ID 的 read fence 分别确认', async () => {
    const original = (await store.adminCreateObjective(KEY, 0, objective('原目标'))).value
    await store.adminReviseObjective(KEY, 1, original.objective_id, objective('新目标'))
    const reused = (await store.adminCreateObjective(KEY, 2, objective('原目标'))).value

    const current = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(
      KEY,
      'active',
      current.objectives.filter((entry) => entry.objective_id === original.objective_id),
      current.revision,
    )
    await expect(store.reviseObjective(KEY, original.objective_id, objective('新目标'))).resolves.toBeDefined()
    await expect(store.reviseObjective(KEY, reused.objective_id, objective('原目标'))).rejects.toThrow('请先使用 inspect_workboard')

    const refreshed = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(
      KEY,
      'active',
      refreshed.objectives.filter((entry) => entry.objective_id === reused.objective_id),
      refreshed.revision,
    )
    await expect(store.reviseObjective(KEY, reused.objective_id, objective('原目标'))).resolves.toBeDefined()
  })

  it('Manager 改目标标题不改变未读事项 fence 的稳定地址', async () => {
    const createdObjective = await createObjective('旧目标')
    const createdItem = await createWorkItem(createdObjective.objective_id, '管理员事项')
    await store.adminReviseWorkItem(KEY, 2, createdItem.work_item_id, undefined, item('管理员事项', {
      status: 'in_progress', current_judgement: '管理员已更新', next_action: '先核对新内容',
    }))

    await store.reviseObjective(KEY, createdObjective.objective_id, objective('新目标'))
    await expect(store.createObjective(KEY, objective('旧目标'))).resolves.toBeDefined()
    await expect(store.reviseWorkItem(KEY, createdItem.work_item_id, undefined, item('管理员事项'))).rejects.toThrow('请先使用 inspect_workboard')

    const visible = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', visible.objectives, visible.revision)
    await expect(store.reviseWorkItem(KEY, createdItem.work_item_id, undefined, item('管理员事项'))).resolves.toBeDefined()
  })

  it('Admin 归档事项后同一 ID 的 Manager 写先要求查阅，再报告事项不存在', async () => {
    const createdObjective = await createObjective('目标甲')
    const createdItem = await createWorkItem(createdObjective.objective_id, '事项甲')
    await store.adminArchiveWorkItem(KEY, 2, createdItem.work_item_id, 'completed')

    await expect(store.reviseWorkItem(KEY, createdItem.work_item_id, undefined, item('事项甲'))).rejects.toThrow('请先使用 inspect_workboard')
    const archive = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'archive', archive.archive, archive.revision)
    await expect(store.reviseWorkItem(KEY, createdItem.work_item_id, undefined, item('事项甲'))).rejects.toThrow(/当前事项不存在/)
  })

  it('Admin CAS、notice 与 read fence 在同一原子写入边界', async () => {
    const createdObjective = await createObjective('目标甲')
    const createdItem = (await store.adminCreateWorkItem(KEY, 1, createdObjective.objective_id, item('事项甲'))).value
    await expect(store.adminCreateObjective(KEY, 1, objective('旧表单'))).rejects.toMatchObject({
      code: 'WORKBOARD_REVISION_CONFLICT', currentRevision: 2,
    })
    await expect(store.pendingAdminNotice(KEY)).resolves.toMatchObject({ revision: 2 })

    const board = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', board.objectives, board.revision)
    await store.reviseWorkItem(KEY, createdItem.work_item_id, undefined, item('事项甲', { next_action: '继续执行' }))
    expect((await store.loadAdmin(KEY)).revision).toBe(3)
    await expect(store.clearAdminNoticeIfCurrent(KEY, 3)).resolves.toBe(false)
    await expect(store.clearAdminNoticeIfCurrent(KEY, 2)).resolves.toBe(true)
  })
})
