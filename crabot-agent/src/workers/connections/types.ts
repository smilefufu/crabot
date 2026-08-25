/**
 * Worker connection translator（P6-B plan §7；protocol-agent-v3 §6.5）。
 *
 * 语义边界：
 * - translator 是「连接模式」的唯一注入点：只产出声明的最小 env 增量 /
 *   runtime file / model override；不接受任意 key map，不写 task workspace/普通 config/
 *   ledger/trace。
 * - 每个 translator 在代码中固定：provider formats、endpoint policy、credential transport、
 *   model selection、credential scope。CLI 版本不作为 translator/activation gate；真实
 *   不兼容由显式 verify 或 worker 执行报告。
 * - operation-time resolve：输入的 connection 只在当前调用内存存活；runtime file 由
 *   调用方写 0600 临时文件并在 finally 删除。
 */

import type { ModelFormat } from 'crabot-shared'
import type { CLIWorkerImplId, WorkerConnectionCapability } from '../types.js'

/** operation-time resolve 出的连接（来自 Admin resolve_worker_connection 或 native 重检）。 */
export interface ResolvedWorkerConnection {
  readonly endpoint?: string
  readonly apikey?: string
  readonly model_id?: string
  readonly format?: ModelFormat
}

export interface TranslatorInjection {
  /** 追加进 child env 的最小键值（在 scrub 之后的干净 env 上叠加）。 */
  readonly env: Record<string, string>
  /**
   * 需要落盘的 runtime 文件（相对目标 home 的路径 → 内容）。
   * 调用方负责 0600 写入与 finally 清理。
   */
  readonly runtimeFiles?: Record<string, string>
}

export interface ConnectionTranslator {
  readonly capability: WorkerConnectionCapability & { mode: NonNullable<WorkerConnectionCapability['mode']> }
  readonly impl: CLIWorkerImplId
  /**
   * 构造本次操作的最小注入。admin_provider 必须传 connection；
   * native_account/existing_host 不传（credential 走 CLI 原生 store/宿主 home）。
   * format 不在 provider_formats 内必须抛错（相同 format 不足以证明兼容的反向：
   * 不支持的 format 连试都不试）。
   */
  buildInjection(input: { connection?: ResolvedWorkerConnection }): TranslatorInjection
}
