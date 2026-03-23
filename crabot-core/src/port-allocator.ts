/**
 * 端口分配器
 *
 * 负责为模块分配可用端口，持久化端口分配信息
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { type PortAllocation } from './types.js'

/**
 * 错误类型兼容
 */
type ErrnoException = Error & { code?: string }

/**
 * 端口分配记录
 */
interface PortRecord {
  module_id: string
  port: number
  allocated_at: string
}

/**
 * 端口分配器
 */
export class PortAllocator {
  private readonly range: PortAllocation
  private readonly storagePath: string
  private readonly allocated: Map<string, number> = new Map() // module_id -> port
  private readonly usedPorts: Set<number> = new Set()

  constructor(range: PortAllocation, dataDir: string) {
    this.range = range
    this.storagePath = path.join(dataDir, 'port-allocations.json')
  }

  /**
   * 初始化：从持久化存储加载端口分配
   */
  async initialize(): Promise<void> {
    try {
      const data = await fs.readFile(this.storagePath, 'utf-8')
      const records: PortRecord[] = JSON.parse(data) as PortRecord[]

      for (const record of records) {
        this.allocated.set(record.module_id, record.port)
        this.usedPorts.add(record.port)
      }

      console.log(`[PortAllocator] Loaded ${records.length} port allocations`)
    } catch (error) {
      // 文件不存在或解析失败，从空开始
      if ((error as ErrnoException).code !== 'ENOENT') {
        console.warn('[PortAllocator] Failed to load port allocations:', error)
      }
    }
  }

  /**
   * 为模块分配端口
   */
  allocate(moduleId: string): number {
    // 如果已经分配过，返回之前的端口
    const existing = this.allocated.get(moduleId)
    if (existing !== undefined) {
      return existing
    }

    // 寻找可用端口
    for (let port = this.range.range_start; port <= this.range.range_end; port++) {
      if (!this.usedPorts.has(port)) {
        this.allocated.set(moduleId, port)
        this.usedPorts.add(port)
        this.persist().catch(console.error)
        return port
      }
    }

    throw new Error('Port range exhausted')
  }

  /**
   * 获取模块已分配的端口
   */
  get(moduleId: string): number | undefined {
    return this.allocated.get(moduleId)
  }

  /**
   * 释放模块的端口
   */
  release(moduleId: string): void {
    const port = this.allocated.get(moduleId)
    if (port !== undefined) {
      this.allocated.delete(moduleId)
      this.usedPorts.delete(port)
      this.persist().catch(console.error)
    }
  }

  /**
   * 持久化端口分配
   */
  private async persist(): Promise<void> {
    const records: PortRecord[] = []
    for (const [moduleId, port] of this.allocated) {
      records.push({
        module_id: moduleId,
        port,
        allocated_at: new Date().toISOString(),
      })
    }

    await fs.mkdir(path.dirname(this.storagePath), { recursive: true })
    await fs.writeFile(this.storagePath, JSON.stringify(records, null, 2))
  }
}
