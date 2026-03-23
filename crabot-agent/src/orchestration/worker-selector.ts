/**
 * Worker Selector - 负载均衡选择 Worker
 *
 * 基于 available_capacity 的贪心算法
 */

import type { ModuleId } from '../core/base-protocol.js'
import type { RpcClient } from '../core/module-base.js'
import type { WorkerRoutingInfo } from '../types.js'

export class WorkerSelector {
  constructor(
    private rpcClient: RpcClient,
    private moduleId: string
  ) {}

  /**
   * 选择最佳 Worker
   */
  async selectWorker(params: {
    task_type?: string
    specialization_hint?: string
  }): Promise<ModuleId> {
    // 1. 获取所有 Worker Agent 实例
    const workers = await this.getAvailableWorkers()

    // 2. 过滤：支持 task_type（"general" 表示支持所有类型）
    let candidates = params.task_type
      ? workers.filter((w) => this.supportsTaskType(w.supported_task_types, params.task_type!))
      : workers

    // 3. 过滤：有可用容量
    candidates = candidates.filter((w) => w.available_capacity > 0)

    if (candidates.length === 0) {
      throw new Error('No available workers')
    }

    // 4. 如果有 specialization_hint，优先匹配
    if (params.specialization_hint) {
      const specialized = candidates.filter(
        (w) => w.specialization === params.specialization_hint
      )
      if (specialized.length > 0) {
        candidates = specialized
      }
    }

    // 5. 按 available_capacity 降序排序，选择第一个
    candidates.sort((a, b) => b.available_capacity - a.available_capacity)
    return candidates[0].worker_id
  }

  /**
   * 检查 Worker 是否支持指定任务类型
   * - "general" 表示支持所有任务类型
   */
  private supportsTaskType(supportedTypes: string[], taskType: string): boolean {
    if (!supportedTypes || supportedTypes.length === 0) {
      return false
    }
    // "general" 类型支持所有任务
    if (supportedTypes.includes('general')) {
      return true
    }
    return supportedTypes.includes(taskType)
  }

  /**
   * 获取所有可用 Worker
   */
  private async getAvailableWorkers(): Promise<WorkerRoutingInfo[]> {
    // 通过 Module Manager 解析所有 worker 类型模块
    const modules = await this.rpcClient.resolve(
      { module_type: 'agent' },
      this.moduleId
    )

    const workers: WorkerRoutingInfo[] = []

    for (const mod of modules) {
      try {
        const status = await this.rpcClient.call<
          Record<string, never>,
          {
            available_capacity: number
            specialization: string
            supported_task_types: string[]
          }
        >(mod.port, 'get_status', {}, this.moduleId)

        workers.push({
          worker_id: mod.module_id,
          specialization: status.specialization,
          supported_task_types: status.supported_task_types,
          available_capacity: status.available_capacity,
        })
      } catch {
        // Worker 不可达，跳过
      }
    }

    return workers
  }
}
