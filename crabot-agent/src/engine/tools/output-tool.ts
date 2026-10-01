/** Unified incremental output for background shells and direct subagents. */
import fs from 'node:fs/promises'
import { defineTool } from '../tool-framework'
import { sleep } from '../retry-utils'
import type { OutputWaitEntry, ToolDefinition } from '../types'
import type { BgEntityRegistry } from '../bg-entities/registry'
import { BG_OUTPUT_MAX_BYTES, type BgEntityRecord } from '../bg-entities/types'

export interface BgToolDeps {
  readonly registry: BgEntityRegistry
  readonly cursorMap: Map<string, number>
  readonly taskId: string
  readonly ownerFriendId?: string
  readonly ownerWorkerId?: string
  readonly ownerIncarnationId?: string
  readonly ownerSubagentId?: string
  readonly redactText?: (text: string) => string
  readonly stopWorkerAgent?: (entityId: string) => Promise<{ output: string; isError: boolean }>
  readonly agentAbortControllers?: Map<string, AbortController>
}

/** Check before reading or controlling any entity, including sibling children. */
export function ownsBgEntity(record: BgEntityRecord, deps: BgToolDeps): boolean {
  if (deps.ownerWorkerId) {
    return record.owner?.worker_id === deps.ownerWorkerId
      && record.owner.incarnation_id === deps.ownerIncarnationId
      && record.owner.subagent_id === deps.ownerSubagentId
  }
  return deps.ownerFriendId ? record.owner?.friend_id === deps.ownerFriendId
    : record.spawned_by_task_id === deps.taskId
}

async function readChunk(file: string, offset: number, redact?: (text: string) => string): Promise<{ text: string; next: number; more: boolean }> {
  if (redact) {
    const bytes = Buffer.from(redact(await fs.readFile(file, 'utf8')))
    if (offset > bytes.length) throw new Error('from_offset exceeds output size')
    let end = Math.min(offset + BG_OUTPUT_MAX_BYTES, bytes.length)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    return { text: bytes.subarray(offset, end).toString('utf8'), next: end, more: end < bytes.length }
  }
  const handle = await fs.open(file, 'r')
  try {
    const size = (await handle.stat()).size
    if (offset > size) throw new Error('from_offset exceeds output size')
    const buffer = Buffer.alloc(Math.min(BG_OUTPUT_MAX_BYTES, size - offset))
    let { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    // Do not split a UTF-8 codepoint at the page boundary.
    if (offset + bytesRead < size) {
      let start = bytesRead - 1
      while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--
      if (start >= 0) {
        const lead = buffer[start]
        const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
        if (start + width > bytesRead) bytesRead = start
      }
    }
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), next: offset + bytesRead, more: offset + bytesRead < size }
  } finally { await handle.close() }
}

export function createOutputTool(deps: BgToolDeps): ToolDefinition {
  const localWaitState = new Map<string, OutputWaitEntry>()
  return defineTool({
    name: 'Output', category: 'shell', isReadOnly: true, permissionLevel: 'safe',
    description: '读取后台 Shell 或子 Agent 的增量输出。已有新输出时立即返回；否则初始最多等待子 Agent 15 分钟、Shell 2 分钟。同一目标连续无输出超时后，系统将下次等待上限翻倍，最高 2 小时；读到新输出后恢复初始上限。期间出现新输出、目标结束或调用方收到新输入时会提前返回；调用方取消也会解除等待。读取超时不会终止目标。子 Agent 的中间文本不代表任务完成。等待时长由系统管理，无需指定。',
    inputSchema: {
      type: 'object', required: ['entity_id'], properties: {
        entity_id: { type: 'string', description: 'shell_xxx 或 agent_xxx' },
        from_offset: { type: 'integer', minimum: 0, description: '可选的输出字节偏移；默认从当前调用者上次读取的位置继续，可指定偏移重读。' },
      },
    },
    call: async (input, context) => {
      const id = input.entity_id
      if (typeof id !== 'string' || !/^(shell|agent)_/.test(id)) return { output: 'Invalid entity_id', isError: true }
      if (input.from_offset !== undefined && (!Number.isSafeInteger(input.from_offset) || (input.from_offset as number) < 0)) {
        return { output: 'Invalid from_offset: expected a non-negative safe integer', isError: true }
      }
      const initial = await deps.registry.get(id)
      if (!initial || !ownsBgEntity(initial, deps)) return { output: 'Entity not found or not accessible', isError: true }
      const initialWait = initial.type === 'agent' ? 900_000 : 120_000
      const started = Date.now()
      const key = `${deps.taskId}:${deps.ownerIncarnationId ?? ''}:${deps.ownerSubagentId ?? ''}:${id}`
      const waitState = context.outputWaitState ?? localWaitState
      const startedState = waitState.get(key) ?? { waitMs: initialWait, readOffset: deps.cursorMap.get(key) ?? 0 }
      waitState.set(key, startedState)
      const deadline = started + startedState.waitMs
      let waiting = false
      try {
        for (;;) {
          const record = await deps.registry.get(id)
          if (!record || !ownsBgEntity(record, deps)) return { output: 'Entity not found or not accessible', isError: true }
          const header = `[status: ${record.status}, exit_code: ${record.exit_code ?? 'null'}]\n[entity_id: ${id}, type: ${record.type}]`
          const reply = (reason: string, text = '(no new output)') => ({ output: `${header}\n[reason: ${reason}]\n${text}`, isError: false })
          if (context.abortSignal?.aborted) return reply('aborted')
          if (context.hasPendingExternalInput?.()) return reply('external_input')
          const terminal = record.status !== 'running'
          const file = record.type === 'shell' ? record.log_file : record.output_file ?? (terminal ? record.result_file : null)
          if (!file && !terminal) return reply('unavailable', 'Intermediate output unavailable for this legacy child.')
          let chunk = { text: '', next: 0, more: false }
          try {
            if (file) chunk = await readChunk(file, (input.from_offset as number | undefined) ?? deps.cursorMap.get(key) ?? 0, record.type === 'agent' && !record.output_file ? deps.redactText : undefined)
          } catch (error) {
            return { output: `${header}\nOutput unavailable: ${error instanceof Error ? error.message : String(error)}`, isError: true }
          }
          // Do not consume a page if input arrived during file I/O.
          if (context.hasPendingExternalInput?.()) return reply('external_input')
          if (chunk.text || terminal) {
            await deps.registry.update(id, { last_activity_at: new Date().toISOString() })
            if (context.hasPendingExternalInput?.()) return reply('external_input')
            if (file) deps.cursorMap.set(key, chunk.next)
            if (terminal) waitState.delete(key)
            else if (chunk.next > (waitState.get(key)?.readOffset ?? 0)) {
              waitState.set(key, { waitMs: initialWait, readOffset: chunk.next })
            }
            const error = record.type === 'agent' && record.error ? `\nerror: ${(deps.redactText?.(record.error) ?? record.error).slice(0, 3000)}` : ''
            return reply(terminal ? 'terminal' : 'new_output',
              `${record.type === 'agent' && !terminal ? '[progress]\n' : ''}${chunk.text || '(no new output)'}${error}\n[next_offset: ${chunk.next}${chunk.more ? ', truncated; more available' : ''}]`)
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            // Compare the snapshot: parallel timeouts advance once, and cannot undo newer progress.
            if (waitState.get(key) === startedState) {
              waitState.set(key, { ...startedState, waitMs: Math.min(7_200_000, startedState.waitMs * 2) })
            }
            return reply('timeout')
          }
          if (!waiting) {
            waiting = true
            context.onOutputWait?.(deadline)
          }
          try { await sleep(Math.min(2_000, remaining), context.abortSignal) }
          catch { return reply('aborted') }
        }
      } finally {
        if (waiting) context.onOutputWait?.(undefined)
      }
    },
  })
}
