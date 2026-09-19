import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ManagerWorkboardStore } from '../../src/manager/workboard-store.js'
import { buildWorkboardTools } from '../../src/manager/tools/workboard-tools.js'
import type { ManagerKey } from '../../src/manager/types.js'

const KEY = 'feishu::cotton-candy' as ManagerKey

function objective(title: string, criterion = `完成 ${title}`) {
  return { title, completion_criteria: [criterion] }
}

function item(title: string, nextAction = '开始推进') {
  return { title, status: 'ready' as const, next_action: nextAction }
}

describe('workboard tools', () => {
  let root: string
  let tools: ReturnType<typeof buildWorkboardTools>

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'workboard-tools-'))
    tools = buildWorkboardTools({
      store: new ManagerWorkboardStore(root, () => '2026-09-06T00:00:00.000Z'),
      managerKey: KEY,
    })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function tool(name: string) {
    return tools.find((candidate) => candidate.name === name)!
  }

  async function change(input: Record<string, unknown>) {
    const result = await tool('change_workboard').call(input, {} as never)
    expect(result.isError).toBe(false)
    return JSON.parse(result.output) as Record<string, unknown>
  }

  it.each(['completed', 'abandoned'])('最后事项 %s 后提醒复核，目标仍保留且不自动完成', async (archivedAs) => {
    const created = await change({ action: 'create_objective', objective: objective('待核实目标') })
    expect(created).not.toHaveProperty('system_reminder')
    const objectiveId = (created.objective as { objective_id: string }).objective_id
    const first = await change({ action: 'create_work_item', objective_id: objectiveId, work_item: item('第一项') })
    const last = await change({ action: 'create_work_item', objective_id: objectiveId, work_item: item('最后一项') })
    const firstId = (first.work_item as { work_item_id: string }).work_item_id
    const lastId = (last.work_item as { work_item_id: string }).work_item_id
    expect(await change({ action: 'archive_work_item', work_item_id: firstId, archived_as: archivedAs }))
      .not.toHaveProperty('system_reminder')
    const result = await change({ action: 'archive_work_item', work_item_id: lastId, archived_as: archivedAs })
    expect(result.system_reminder).toEqual({
      objective_id: objectiveId,
      title: '待核实目标',
      message: expect.stringContaining('不要仅因事项清空就认定目标完成'),
    })
    expect(result.counts).toMatchObject({ current_objectives: 1, current_work_items: 0 })
    const failed = await tool('change_workboard').call({ action: 'archive_work_item', work_item_id: lastId, archived_as: archivedAs }, {} as never)
    expect(failed.isError).toBe(true)
    expect(failed.output).not.toContain('system_reminder')
    expect(await change({ action: 'archive_objective', objective_id: objectiveId, archived_as: archivedAs }))
      .not.toHaveProperty('system_reminder')
  })

  it('原地修订不提醒，最后事项跨目标移动只提醒源目标', async () => {
    const source = await change({ action: 'create_objective', objective: objective('源目标') })
    const target = await change({ action: 'create_objective', objective: objective('新目标') })
    const sourceId = (source.objective as { objective_id: string }).objective_id
    const targetId = (target.objective as { objective_id: string }).objective_id
    const created = await change({ action: 'create_work_item', objective_id: sourceId, work_item: item('事项') })
    const workItemId = (created.work_item as { work_item_id: string }).work_item_id
    expect(await change({ action: 'revise_work_item', work_item_id: workItemId, work_item: item('事项') }))
      .not.toHaveProperty('system_reminder')
    const moved = await change({ action: 'revise_work_item', work_item_id: workItemId, target_objective_id: targetId, work_item: item('事项') })
    expect(moved.objective).toMatchObject({ objective_id: targetId })
    expect(moved.system_reminder).toMatchObject({ objective_id: sourceId, title: '源目标' })
  })

  it('只暴露两个工具和六种 action，写入按内部 ID 寻址且不带无关字段', () => {
    expect(tools.map((entry) => entry.name)).toEqual(['inspect_workboard', 'change_workboard'])
    expect(tool('inspect_workboard').isReadOnly).toBe(true)
    expect(tool('change_workboard').isReadOnly).toBe(false)

    const schema = JSON.stringify(tool('change_workboard').inputSchema)
    for (const action of [
      'create_objective', 'revise_objective', 'archive_objective',
      'create_work_item', 'revise_work_item', 'archive_work_item',
    ]) {
      expect(schema).toContain(action)
    }
    expect(schema).toContain('objective_id')
    expect(schema).toContain('work_item_id')
    expect(schema).toContain('target_objective_id')
    for (const forbidden of [
      'current_objective_title', 'objective_title', 'current_work_item_title', 'target_objective_title',
      'worker_id', 'priority', 'reason', 'revision_note', 'decision_doc',
    ]) {
      expect(schema.toLowerCase()).not.toContain(forbidden)
    }
    expect(tool('change_workboard').description).toContain('派发执行器不要求建项')
  })

  it('六种 action 返回变更对象和紧凑计数', async () => {
    const createdObjective = await change({ action: 'create_objective', objective: objective('恢复会话记忆一致性') })
    expect(createdObjective).toMatchObject({
      action: 'objective_created',
      objective: { objective_id: expect.any(String), title: '恢复会话记忆一致性' },
      counts: { current_objectives: 1, current_work_items: 0, archive_entries: 0 },
    })
    expect(createdObjective.objective).not.toHaveProperty('work_items')
    const firstObjectiveId = (createdObjective.objective as { objective_id: string }).objective_id

    const secondObjective = await change({ action: 'create_objective', objective: objective('建立隔离评测') })
    const secondObjectiveId = (secondObjective.objective as { objective_id: string }).objective_id
    await change({
      action: 'revise_objective',
      objective_id: firstObjectiveId,
      objective: objective('恢复会话上下文一致性', '连续回顾保持一致'),
    })
    const createdItem = await change({
      action: 'create_work_item',
      objective_id: firstObjectiveId,
      work_item: item('核查请求链路'),
    })
    const workItemId = (createdItem.work_item as { work_item_id: string }).work_item_id
    expect(createdItem).toMatchObject({
      objective: { objective_id: firstObjectiveId, title: '恢复会话上下文一致性' },
      work_item: { work_item_id: workItemId },
    })
    const revisedItem = await change({
      action: 'revise_work_item',
      work_item_id: workItemId,
      target_objective_id: secondObjectiveId,
      work_item: {
        title: '验证真实请求',
        status: 'in_progress',
        current_judgement: '已完成固定样例',
        next_action: '运行真实模型评测',
      },
    })
    expect(revisedItem).toMatchObject({
      action: 'work_item_revised',
      objective: { objective_id: secondObjectiveId, title: '建立隔离评测' },
      work_item: { work_item_id: workItemId, title: '验证真实请求' },
      counts: { current_objectives: 2, current_work_items: 1 },
    })

    const archivedItem = await change({
      action: 'archive_work_item',
      work_item_id: workItemId,
      archived_as: 'completed',
    })
    expect(archivedItem).toMatchObject({ action: 'work_item_archived', counts: { current_work_items: 0, archive_entries: 1 } })

    const archivedObjective = await change({
      action: 'archive_objective',
      objective_id: secondObjectiveId,
      archived_as: 'abandoned',
    })
    expect(archivedObjective).toMatchObject({ action: 'objective_archived', counts: { current_objectives: 1, archive_entries: 2 } })
  })

  it('inspect active 按目标过滤和分页，命中事项时返回完整目标分组', async () => {
    await change({ action: 'create_objective', objective: objective('目标乙', '其它完成条件') })
    const created = await change({ action: 'create_objective', objective: objective('目标甲', '恢复棉花糖回顾') })
    const objectiveId = (created.objective as { objective_id: string }).objective_id
    await change({ action: 'create_work_item', objective_id: objectiveId, work_item: item('事项甲', '核对棉花糖时间线') })
    await change({ action: 'create_work_item', objective_id: objectiveId, work_item: item('事项乙', '准备回归样例') })

    const result = await tool('inspect_workboard').call({ query: '棉花糖', page: 1, page_size: 1 }, {} as never)
    expect(JSON.parse(result.output)).toMatchObject({
      view: 'active',
      objectives: [{ objective_id: objectiveId, title: '目标甲', work_items: [
        { work_item_id: expect.any(String), title: '事项乙' },
        { work_item_id: expect.any(String), title: '事项甲' },
      ] }],
      counts: { current_objectives: 2, current_work_items: 2, blocked_work_items: 0, archive_entries: 0 },
      pagination: { page: 1, page_size: 1, total_items: 1, total_pages: 1 },
    })
  })

  it('inspect archive 返回目标与事项最终快照并按归档时间倒序', async () => {
    const createdObjective = await change({ action: 'create_objective', objective: objective('目标甲') })
    const objectiveId = (createdObjective.objective as { objective_id: string }).objective_id
    const createdItem = await change({ action: 'create_work_item', objective_id: objectiveId, work_item: item('事项甲') })
    const workItemId = (createdItem.work_item as { work_item_id: string }).work_item_id
    await change({
      action: 'archive_work_item',
      work_item_id: workItemId,
      archived_as: 'completed',
    })
    await change({ action: 'archive_objective', objective_id: objectiveId, archived_as: 'completed' })

    const result = await tool('inspect_workboard').call({ view: 'archive' }, {} as never)
    expect(JSON.parse(result.output)).toMatchObject({
      view: 'archive',
      entries: [
        { work_item_id: workItemId, title: '事项甲', objective: { title: '目标甲' }, archived_as: 'completed' },
        { objective_id: objectiveId, title: '目标甲', completion_criteria: ['完成 目标甲'], archived_as: 'completed' },
      ],
      counts: { current_objectives: 0, current_work_items: 0, archive_entries: 2 },
    })
  })

  it('非法 action、分页、旧定位字段和不存在的 ID 返回工具错误', async () => {
    expect((await tool('change_workboard').call({ action: 'merge' }, {} as never)).isError).toBe(true)
    expect((await tool('inspect_workboard').call({ page_size: 101 }, {} as never)).isError).toBe(true)
    expect((await tool('change_workboard').call({
      action: 'create_objective', objective: objective('目标甲'), worker_id: 'nope',
    }, {} as never)).isError).toBe(true)
    expect((await tool('change_workboard').call({
      action: 'archive_work_item',
      work_item_id: '00000000-0000-4000-8000-000000000001',
      archived_as: 'completed',
    }, {} as never)).isError).toBe(true)
    expect((await tool('change_workboard').call({
      action: 'revise_objective',
      current_objective_title: '旧标题定位',
      objective: objective('新标题'),
    }, {} as never)).isError).toBe(true)
  })
})
