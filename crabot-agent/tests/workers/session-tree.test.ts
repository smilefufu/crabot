import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionTree } from '../../src/workers/session-tree'
import { createUserMessage, createAssistantMessage } from '../../src/engine/types'
import type { EngineMessage } from '../../src/engine/types'

// 本地 helper：构造 EngineMessage
function u(text: string): EngineMessage {
  return createUserMessage(text)
}
function asst(text: string): EngineMessage {
  return createAssistantMessage([{ type: 'text', text }], 'end_turn')
}

describe('SessionTree', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'session-tree-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('append 链 + pathTo 还原正序消息', async () => {
    const tree = new SessionTree(join(tmp, 's.jsonl'))
    const a = await tree.append(null, u('hi'))
    const b = await tree.append(a, asst('yo'))
    expect(tree.pathTo(b).map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(tree.latestTip()).toBe(b)
  })

  it('分支:同一父节点两个子,两条 pathTo 互不污染', async () => {
    const tree = new SessionTree(join(tmp, 's.jsonl'))
    const root = await tree.append(null, u('root'))
    const branchA = await tree.append(root, asst('branch-a'))
    const branchB = await tree.append(root, asst('branch-b'))

    const pathA = tree.pathTo(branchA)
    const pathB = tree.pathTo(branchB)

    expect(pathA).toHaveLength(2)
    expect(pathB).toHaveLength(2)
    expect(pathA[1].id).not.toBe(pathB[1].id)

    const lastA = pathA[1]
    const lastB = pathB[1]
    expect(lastA.role).toBe('assistant')
    expect(lastB.role).toBe('assistant')
    if (lastA.role === 'assistant' && lastB.role === 'assistant') {
      expect((lastA.content[0] as { type: 'text'; text: string }).text).toBe('branch-a')
      expect((lastB.content[0] as { type: 'text'; text: string }).text).toBe('branch-b')
    }
  })

  it('load 重建:进程重启后 pathTo/latestTip 一致', async () => {
    const filePath = join(tmp, 's.jsonl')
    const tree = new SessionTree(filePath)
    const a = await tree.append(null, u('hi'))
    const b = await tree.append(a, asst('yo'))

    const reloaded = await SessionTree.load(filePath)
    expect(reloaded.latestTip()).toBe(b)
    expect(reloaded.pathTo(b).map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(reloaded.pathTo(b).map((m) => m.id)).toEqual(tree.pathTo(b).map((m) => m.id))
  })

  it('append 并发安全(AsyncMutex):10 个并发 append 不丢行', async () => {
    const filePath = join(tmp, 's.jsonl')
    const tree = new SessionTree(filePath)
    const root = await tree.append(null, u('root'))

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => tree.append(root, asst(`child-${i}`)))
    )

    // 全部 node_id 唯一
    expect(new Set(results).size).toBe(10)

    // 重新 load,文件里应有 11 行(root + 10 children),且都能从 tree 里查到
    const reloaded = await SessionTree.load(filePath)
    for (const nodeId of results) {
      expect(reloaded.pathTo(nodeId)).toHaveLength(2)
    }
    const raw = await fs.readFile(filePath, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(11)
  })

  it('append 非法 parentId(树中不存在的节点) 在锁内同步抛错,不落脏数据', async () => {
    const filePath = join(tmp, 's.jsonl')
    const tree = new SessionTree(filePath)
    await tree.append(null, u('root'))

    await expect(tree.append('不存在的node-id', asst('侧问'))).rejects.toThrow(/unknown parent_id/)

    // 非法 append 没有落盘：文件里仍然只有 root 这一行。
    const raw = await fs.readFile(filePath, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(1)

    // 校验没有把 mutex 卡死：后续合法 append 仍然可用。
    const rootId = tree.latestTip()!
    const childId = await tree.append(rootId, asst('合法子节点'))
    expect(tree.pathTo(childId)).toHaveLength(2)
  })
})
