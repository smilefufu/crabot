import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  ManagerWorkboardStore,
  type WorkboardItemDraft,
  type WorkboardObjectiveDraft,
} from '../../src/manager/workboard-store.js'
import { encodeSegment } from '../../src/workers/harness/ledger-store.js'
import type { ManagerKey } from '../../src/manager/types.js'

const KEY = 'feishu::cotton-candy' as ManagerKey
const OTHER_KEY = 'feishu::other' as ManagerKey

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

describe('ManagerWorkboardStore', () => {
  let root: string
  let nowIndex: number
  let store: ManagerWorkboardStore

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'manager-workboard-'))
    nowIndex = 0
    store = new ManagerWorkboardStore(root, () =>
      new Date(Date.parse('2026-09-06T00:00:00.000Z') + nowIndex++ * 1_000).toISOString(),
    )
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('缺文件返回一张空板且不产生目录', async () => {
    await expect(store.load(KEY)).resolves.toEqual({
      manager_key: KEY,
      objectives: [],
      archive: [],
    })
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('同一会话支持多目标多事项，不同会话相互隔离', async () => {
    await store.createObjective(KEY, objective('恢复会话记忆一致性'))
    await store.createObjective(KEY, objective('建立隔离回归环境'))
    await store.createWorkItem(KEY, '恢复会话记忆一致性', item('核查请求链路'))
    await store.createWorkItem(KEY, '恢复会话记忆一致性', item('验证压缩后回顾'))
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

  it('修订目标保留事项，事项可原地修订或原子移动到另一目标', async () => {
    await store.createObjective(KEY, objective('目标甲'))
    await store.createObjective(KEY, objective('目标乙'))
    await store.createWorkItem(KEY, '目标甲', item('核查上下文'))
    const before = await store.load(KEY)
    const itemUpdatedAt = before.objectives[0].work_items[0].updated_at

    const revisedObjective = await store.reviseObjective(KEY, '目标甲', objective('目标甲新版', ['条件一', '条件二']))
    expect(revisedObjective.value).toMatchObject({
      title: '目标甲新版',
      completion_criteria: ['条件一', '条件二'],
      work_items: [{ title: '核查上下文', updated_at: itemUpdatedAt }],
    })

    const revisedItem = await store.reviseWorkItem(
      KEY,
      '目标甲新版',
      '核查上下文',
      '目标甲新版',
      item('核查上下文', {
        status: 'in_progress',
        current_judgement: '已确认历史输入有缺口',
        next_action: '判断缺口是否影响结论',
      }),
    )
    expect(revisedItem.value).toMatchObject({ status: 'in_progress', current_judgement: '已确认历史输入有缺口' })

    const moved = await store.reviseWorkItem(
      KEY,
      '目标甲新版',
      '核查上下文',
      '目标乙',
      item('核查请求链路', { next_action: '在新目标下继续核查' }),
    )
    expect(moved.value.title).toBe('核查请求链路')
    expect(moved.board.objectives.find((entry) => entry.title === '目标甲新版')?.work_items).toEqual([])
    expect(moved.board.objectives.find((entry) => entry.title === '目标乙')?.work_items).toMatchObject([
      { title: '核查请求链路' },
    ])
  })

  it('事项归档保存目标快照，目标只有为空时才能归档', async () => {
    await store.createObjective(KEY, objective('恢复会话记忆一致性', ['回顾前后一致']))
    await store.createWorkItem(KEY, '恢复会话记忆一致性', item('核查请求链路'))

    await expect(store.archiveObjective(KEY, '恢复会话记忆一致性', 'completed')).rejects.toThrow(/仍有当前事项/)
    const archivedItem = await store.archiveWorkItem(KEY, '恢复会话记忆一致性', '核查请求链路', 'completed')
    expect(archivedItem.value).toMatchObject({
      title: '核查请求链路',
      objective: { title: '恢复会话记忆一致性', completion_criteria: ['回顾前后一致'] },
      archived_as: 'completed',
    })

    const archivedObjective = await store.archiveObjective(KEY, '恢复会话记忆一致性', 'completed')
    expect(archivedObjective.board.objectives).toEqual([])
    expect(archivedObjective.board.archive).toMatchObject([
      { title: '核查请求链路', archived_as: 'completed' },
      { title: '恢复会话记忆一致性', completion_criteria: ['回顾前后一致'], archived_as: 'completed' },
    ])
  })

  it('校验两级标题、完成条件、状态字段、大小与项目根目录', async () => {
    await store.createObjective(KEY, objective('目标甲'))
    await store.createObjective(KEY, objective('目标乙'))
    await expect(store.createObjective(KEY, objective(' 目标甲 '))).rejects.toThrow(/重复|标题/)
    await expect(store.createObjective(KEY, objective('目标丙', []))).rejects.toThrow(/completion_criteria/)
    await expect(store.createObjective(KEY, objective('目标丁', ['1', '2', '3', '4', '5', '6']))).rejects.toThrow(/1 至 5/)

    await store.createWorkItem(KEY, '目标甲', item('同名事项'))
    await store.createWorkItem(KEY, '目标乙', item('同名事项'))
    await expect(store.createWorkItem(KEY, '目标甲', item(' 同名事项 '))).rejects.toThrow(/重复|标题/)
    await expect(store.createWorkItem(KEY, '目标甲', item('非法进行中', { status: 'in_progress' }))).rejects.toThrow(/current_judgement/)
    await expect(store.createWorkItem(KEY, '目标甲', item('非法阻塞', {
      status: 'blocked', current_judgement: '等待条件',
    }))).rejects.toThrow(/blocker/)
    await expect(store.createWorkItem(KEY, '目标甲', item('非法待开始', { blocker: '不应存在' }))).rejects.toThrow(/blocker/)
    await expect(store.createWorkItem(KEY, '目标甲', item('相对路径', { project_root: './relative' }))).rejects.toThrow(/project_root/)
    await expect(store.createWorkItem(KEY, '目标甲', item('未规范路径', { project_root: '/tmp/a/../b' }))).rejects.toThrow(/project_root/)
    await expect(store.createWorkItem(KEY, '目标甲', item('超大事项', { next_action: 'x'.repeat(40_000) }))).rejects.toThrow(/32 KiB/)
  })

  it('坏 JSON、错误 manager_key、旧版本和非法字段都 fail-loud', async () => {
    const dir = join(root, encodeSegment(KEY))
    const file = join(dir, 'workboard.json')
    await fs.mkdir(dir, { recursive: true })

    await fs.writeFile(file, '{ bad json', 'utf-8')
    await expect(store.load(KEY)).rejects.toThrow(/JSON|损坏/)

    await fs.writeFile(file, JSON.stringify({ schema_version: 3, manager_key: OTHER_KEY, revision: 0, objectives: [], archive: [] }))
    await expect(store.load(KEY)).rejects.toThrow(/manager_key/)

    await fs.writeFile(file, JSON.stringify({ schema_version: 2, manager_key: KEY, revision: 0, active: [], archive: [] }))
    await expect(store.load(KEY)).rejects.toThrow(/schema_version/)

    await fs.writeFile(file, JSON.stringify({ schema_version: 3, manager_key: KEY, revision: 0, objectives: [], archive: [], id: 'nope' }))
    await expect(store.load(KEY)).rejects.toThrow(/字段|shape/)
  })

  it('并发创建事项经过同一读改写锁且不丢数据', async () => {
    await store.createObjective(KEY, objective('并发目标'))
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      store.createWorkItem(KEY, '并发目标', item(`并发事项 ${index}`)),
    ))

    const items = (await store.load(KEY)).objectives[0].work_items
    expect(items).toHaveLength(12)
    expect(new Set(items.map((entry) => entry.title)).size).toBe(12)
  })

  it('Admin 目标 fence 阻止目标及其事项修改，读取完整目标后解除', async () => {
    await store.createObjective(KEY, objective('目标甲'))
    await store.createWorkItem(KEY, '目标甲', item('事项甲'))
    const admin = await store.adminReviseObjective(KEY, 2, '目标甲', objective('目标甲新版'))
    expect(admin.board.revision).toBe(3)
    expect(admin.notice).toMatchObject({ revision: 3, attempts: 0 })

    await expect(store.reviseObjective(KEY, '目标甲新版', objective('目标甲最终版'))).rejects.toThrow('请先使用 inspect_workboard')
    await expect(store.createWorkItem(KEY, '目标甲新版', item('事项乙'))).rejects.toThrow('请先使用 inspect_workboard')
    await expect(store.reviseWorkItem(KEY, '目标甲新版', '事项甲', '目标甲新版', item('事项甲'))).rejects.toThrow('请先使用 inspect_workboard')

    const visible = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', visible.objectives, visible.revision)
    await expect(store.createWorkItem(KEY, '目标甲新版', item('事项乙'))).resolves.toBeDefined()
  })

  it('Admin 事项 fence 只阻止同一事项，且旧读取不能确认后续更新', async () => {
    await store.createObjective(KEY, objective('目标甲'))
    await store.createWorkItem(KEY, '目标甲', item('事项甲'))
    await store.createWorkItem(KEY, '目标甲', item('事项乙'))
    await store.adminReviseWorkItem(KEY, 3, '目标甲', '事项甲', '目标甲', item('事项甲', {
      status: 'in_progress', current_judgement: '管理员第一次更新', next_action: '继续核对',
    }))
    const stale = await store.loadAdmin(KEY)
    await store.adminReviseWorkItem(KEY, 4, '目标甲', '事项甲', '目标甲', item('事项甲', {
      status: 'in_progress', current_judgement: '管理员第二次更新', next_action: '按新判断推进',
    }))

    await expect(store.reviseWorkItem(KEY, '目标甲', '事项乙', '目标甲', item('事项乙', { next_action: '独立推进' }))).resolves.toBeDefined()
    await store.acknowledgeManagerRead(KEY, 'active', stale.objectives, stale.revision)
    await expect(store.reviseWorkItem(KEY, '目标甲', '事项甲', '目标甲', item('事项甲'))).rejects.toThrow('请先使用 inspect_workboard')

    const current = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', current.objectives, current.revision)
    await expect(store.reviseWorkItem(KEY, '目标甲', '事项甲', '目标甲', item('事项甲', { next_action: '按最新要求执行' }))).resolves.toBeDefined()
  })

  it('Admin 跨目标移动保留前后位置别名，读取迁入目标后解除', async () => {
    await store.createObjective(KEY, objective('来源目标'))
    await store.createObjective(KEY, objective('迁入目标'))
    await store.createWorkItem(KEY, '来源目标', item('旧事项'))
    await store.adminReviseWorkItem(KEY, 3, '来源目标', '旧事项', '迁入目标', item('新事项'))

    await expect(store.createWorkItem(KEY, '来源目标', item('旧事项'))).rejects.toThrow('请先使用 inspect_workboard')
    await expect(store.reviseWorkItem(KEY, '迁入目标', '新事项', '迁入目标', item('新事项'))).rejects.toThrow('请先使用 inspect_workboard')

    const visible = await store.loadAdmin(KEY)
    const target = visible.objectives.filter((entry) => entry.title === '迁入目标')
    await store.acknowledgeManagerRead(KEY, 'active', target, visible.revision)
    await expect(store.createWorkItem(KEY, '来源目标', item('旧事项'))).resolves.toBeDefined()
    await expect(store.reviseWorkItem(KEY, '迁入目标', '新事项', '迁入目标', item('新事项'))).resolves.toBeDefined()
  })

  it('Admin 跨目标移动后复用旧标题时，两项 read fence 分别确认', async () => {
    await store.createObjective(KEY, objective('来源目标'))
    await store.createObjective(KEY, objective('迁入目标'))
    await store.createWorkItem(KEY, '来源目标', item('同名事项'))
    await store.adminReviseWorkItem(KEY, 3, '来源目标', '同名事项', '迁入目标', item('同名事项'))
    await store.adminCreateWorkItem(KEY, 4, '来源目标', item('同名事项', { next_action: '推进新事项' }))

    const current = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(
      KEY,
      'active',
      current.objectives.filter((entry) => entry.title === '迁入目标'),
      current.revision,
    )
    await expect(store.reviseWorkItem(
      KEY,
      '迁入目标',
      '同名事项',
      '迁入目标',
      item('同名事项', { next_action: '继续迁入事项' }),
    )).resolves.toBeDefined()
    await expect(store.reviseWorkItem(
      KEY,
      '来源目标',
      '同名事项',
      '来源目标',
      item('同名事项', { next_action: '继续新事项' }),
    )).rejects.toThrow('请先使用 inspect_workboard')

    const refreshed = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(
      KEY,
      'active',
      refreshed.objectives.filter((entry) => entry.title === '来源目标'),
      refreshed.revision,
    )
    await expect(store.reviseWorkItem(
      KEY,
      '来源目标',
      '同名事项',
      '来源目标',
      item('同名事项', { next_action: '已核对后继续' }),
    )).resolves.toBeDefined()
  })

  it('Admin 改目标标题后复用旧标题时，两个目标的 read fence 分别确认', async () => {
    await store.adminCreateObjective(KEY, 0, objective('原目标'))
    await store.adminReviseObjective(KEY, 1, '原目标', objective('新目标'))
    await store.adminCreateObjective(KEY, 2, objective('原目标'))

    const current = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(
      KEY,
      'active',
      current.objectives.filter((entry) => entry.title === '新目标'),
      current.revision,
    )
    await expect(store.reviseObjective(KEY, '新目标', objective('新目标'))).resolves.toBeDefined()
    await expect(store.reviseObjective(KEY, '原目标', objective('原目标'))).rejects.toThrow('请先使用 inspect_workboard')

    const refreshed = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(
      KEY,
      'active',
      refreshed.objectives.filter((entry) => entry.title === '原目标'),
      refreshed.revision,
    )
    await expect(store.reviseObjective(KEY, '原目标', objective('原目标'))).resolves.toBeDefined()
  })

  it('Manager 改目标标题时为未读事项 fence 保留目标新旧标题', async () => {
    await store.createObjective(KEY, objective('旧目标'))
    await store.createWorkItem(KEY, '旧目标', item('管理员事项'))
    await store.adminReviseWorkItem(KEY, 2, '旧目标', '管理员事项', '旧目标', item('管理员事项', {
      status: 'in_progress', current_judgement: '管理员已更新', next_action: '先核对新内容',
    }))

    await store.reviseObjective(KEY, '旧目标', objective('新目标'))
    await expect(store.reviseWorkItem(KEY, '新目标', '管理员事项', '新目标', item('管理员事项'))).rejects.toThrow('请先使用 inspect_workboard')
    await expect(store.createObjective(KEY, objective('旧目标'))).rejects.toThrow('请先使用 inspect_workboard')

    const visible = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', visible.objectives, visible.revision)
    await expect(store.reviseWorkItem(KEY, '新目标', '管理员事项', '新目标', item('管理员事项'))).resolves.toBeDefined()
  })

  it('Admin CAS、notice 与 read fence 在同一原子写入边界', async () => {
    await store.createObjective(KEY, objective('目标甲'))
    await store.adminCreateWorkItem(KEY, 1, '目标甲', item('事项甲'))
    await expect(store.adminCreateObjective(KEY, 1, objective('旧表单'))).rejects.toMatchObject({
      code: 'WORKBOARD_REVISION_CONFLICT', currentRevision: 2,
    })
    await expect(store.pendingAdminNotice(KEY)).resolves.toMatchObject({ revision: 2 })

    const board = await store.loadAdmin(KEY)
    await store.acknowledgeManagerRead(KEY, 'active', board.objectives, board.revision)
    await store.reviseWorkItem(KEY, '目标甲', '事项甲', '目标甲', item('事项甲', { next_action: '继续执行' }))
    expect((await store.loadAdmin(KEY)).revision).toBe(3)
    await expect(store.clearAdminNoticeIfCurrent(KEY, 3)).resolves.toBe(false)
    await expect(store.clearAdminNoticeIfCurrent(KEY, 2)).resolves.toBe(true)
  })
})
