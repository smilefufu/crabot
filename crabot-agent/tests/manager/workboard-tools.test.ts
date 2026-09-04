import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ManagerWorkboardStore } from '../../src/manager/workboard-store.js'
import { buildWorkboardTools } from '../../src/manager/tools/workboard-tools.js'
import type { ManagerKey } from '../../src/manager/types.js'

const KEY = 'feishu::cotton-candy' as ManagerKey

function item(title: string, state = '等待执行') {
  return {
    title,
    status: 'ready' as const,
    objective: `完成 ${title}`,
    acceptance: ['验收通过'],
    current_state: state,
    next_action: '开始执行',
    blockers: [],
  }
}

describe('workboard tools', () => {
  let root: string
  let tools: ReturnType<typeof buildWorkboardTools>

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'workboard-tools-'))
    tools = buildWorkboardTools({
      store: new ManagerWorkboardStore(root, () => '2026-09-04T00:00:00.000Z'),
      managerKey: KEY,
    })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function tool(name: string) {
    return tools.find((candidate) => candidate.name === name)!
  }

  it('只暴露读写两个窄工具，schema 没有 ID、优先级、理由或关联字段', () => {
    expect(tools.map((entry) => entry.name)).toEqual(['inspect_workboard', 'change_workboard'])
    expect(tool('inspect_workboard').isReadOnly).toBe(true)
    expect(tool('change_workboard').isReadOnly).toBe(false)
    expect(tools.map((entry) => entry.inputSchema.type)).toEqual(['object', 'object'])

    const schemas = JSON.stringify(tools.map((entry) => entry.inputSchema)).toLowerCase()
    for (const forbidden of ['workitem_id', 'worker_id', 'priority', 'reason', 'revision_note', 'decision_doc']) {
      expect(schemas).not.toContain(forbidden)
    }
  })

  it('create、revise、archive 返回当前计数和最终快照', async () => {
    const change = tool('change_workboard')
    const created = await change.call({ action: 'create', item: item('核查上下文') }, {} as never)
    expect(created.isError).toBe(false)
    expect(JSON.parse(created.output)).toMatchObject({ action: 'created', active_count: 1, archive_count: 0 })

    const revised = await change.call({
      action: 'revise',
      current_title: '核查上下文',
      item: { ...item('核查上下文', '已定位缺失验收'), next_action: '补回验收' },
    }, {} as never)
    expect(JSON.parse(revised.output)).toMatchObject({
      action: 'revised',
      item: { current_state: '已定位缺失验收', next_action: '补回验收' },
    })

    const archived = await change.call({
      action: 'archive',
      current_title: '核查上下文',
      archived_as: 'completed',
    }, {} as never)
    expect(JSON.parse(archived.output)).toMatchObject({ action: 'archived', active_count: 0, archive_count: 1 })
  })

  it('inspect 默认只查 active，按字面过滤并分页；archive 必须显式查询', async () => {
    const change = tool('change_workboard')
    await change.call({ action: 'create', item: item('任务乙', '包含棉花糖时间线') }, {} as never)
    await change.call({ action: 'create', item: item('任务甲', '其它内容') }, {} as never)
    await change.call({ action: 'archive', current_title: '任务甲', archived_as: 'completed' }, {} as never)

    const active = await tool('inspect_workboard').call({ query: '棉花糖', page: 1, page_size: 1 }, {} as never)
    expect(JSON.parse(active.output)).toMatchObject({
      view: 'active',
      items: [{ title: '任务乙' }],
      active_count: 1,
      archive_count: 1,
      pagination: { page: 1, page_size: 1, total_items: 1, total_pages: 1 },
    })

    const archive = await tool('inspect_workboard').call({ view: 'archive' }, {} as never)
    expect(JSON.parse(archive.output)).toMatchObject({ view: 'archive', items: [{ title: '任务甲' }] })
  })

  it('非法 action、分页和不存在的精确标题返回工具错误', async () => {
    const change = tool('change_workboard')
    expect((await change.call({ action: 'merge' }, {} as never)).isError).toBe(true)
    expect((await tool('inspect_workboard').call({ page_size: 101 }, {} as never)).isError).toBe(true)
    expect((await change.call({ action: 'archive', current_title: '不存在', archived_as: 'completed' }, {} as never)).isError).toBe(true)
  })
})
