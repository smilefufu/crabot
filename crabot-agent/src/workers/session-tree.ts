/**
 * SessionTree — append-only session 树,JSONL 持久化。
 * 内存 Map<node_id, SessionNode> + 追加写文件,append 由 AsyncMutex 串行化保证原子有序。
 */
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type { EngineMessage } from '../engine/index.js'
import { AsyncMutex } from './async-mutex.js'

export interface SessionNode {
  readonly node_id: string // uuid
  readonly parent_id: string | null // null = 根
  readonly message: EngineMessage
}

export class SessionTree {
  private readonly nodes = new Map<string, SessionNode>()
  private readonly mutex = new AsyncMutex()
  private tip: string | null = null

  constructor(private readonly filePath: string) {}

  static async load(filePath: string): Promise<SessionTree> {
    const tree = new SessionTree(filePath)
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return tree
      throw err
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let node: SessionNode
      try {
        node = JSON.parse(line) as SessionNode
      } catch {
        // 崩溃截断导致的坏行,跳过
        continue
      }
      tree.nodes.set(node.node_id, node)
      tree.tip = node.node_id
    }
    return tree
  }

  /** 追加一条消息为 parentId 的子节点,返回新 node_id;写盘为 append+fsync */
  async append(parentId: string | null, message: EngineMessage): Promise<string> {
    return this.mutex.run(async () => {
      const node: SessionNode = { node_id: randomUUID(), parent_id: parentId, message }
      const line = JSON.stringify(node) + '\n'
      const handle = await fs.open(this.filePath, 'a')
      try {
        await handle.appendFile(line)
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.nodes.set(node.node_id, node)
      this.tip = node.node_id
      return node.node_id
    })
  }

  /** 从某节点回溯到根,返回正序 EngineMessage[](喂给 RunEngineParams.initialMessages) */
  pathTo(nodeId: string): EngineMessage[] {
    const messages: EngineMessage[] = []
    let current: string | null = nodeId
    while (current !== null) {
      const node: SessionNode | undefined = this.nodes.get(current)
      if (!node) throw new Error(`SessionTree: unknown node_id ${current}`)
      messages.push(node.message)
      current = node.parent_id
    }
    return messages.reverse()
  }

  /** 最后 append 的 node_id */
  latestTip(): string | null {
    return this.tip
  }
}
