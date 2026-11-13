import { describe, expect, it, vi } from 'vitest'
import { bindWorkerRequestTool, workerRequestCaller, type WorkerRequestControl } from '../../src/manager/tools/worker-request-context.js'
import type { ConversationRequestAuthority } from '../../src/manager/conversation-request-authority.js'
import type { ToolDefinition } from '../../src/engine/index.js'

const authority = (scope: 'group' | 'request') => ({ executionScope: scope } as ConversationRequestAuthority)
const tool = (name = 'send_to_worker'): { definition: ToolDefinition; call: ReturnType<typeof vi.fn> } => {
  const call = vi.fn(async () => ({ output: 'ok', isError: false }))
  return { call, definition: { name, description: 'fixture', inputSchema: { type: 'object', properties: { worker_id: { type: 'string' }, text: { type: 'string' } } }, isReadOnly: false, call } as ToolDefinition }
}

describe('bindWorkerRequestTool', () => {
  it('does not expose source_id or quote in shared scope', () => {
    const { definition } = tool()
    const bound = bindWorkerRequestTool(definition, { scope: 'shared', authority: async () => undefined })
    expect(bound.inputSchema).toEqual(definition.inputSchema)
    expect(JSON.stringify(bound.inputSchema)).not.toContain('source_id')
    expect(JSON.stringify(bound.inputSchema)).not.toContain('quote')
  })

  it('resolves the caller from the worker operation, never from model input', async () => {
    const { definition, call } = tool()
    const control: WorkerRequestControl = { scope: 'shared', authority: vi.fn(async operation => operation.worker_id === 'w-group' ? authority('group') : undefined) }
    const bound = bindWorkerRequestTool(definition, control)
    expect((await bound.call({ worker_id: 'w-group', text: 'hello' }, {})).isError).toBe(false)
    expect(control.authority).toHaveBeenCalledWith({ tool_name: 'send_to_worker', worker_id: 'w-group' })
    expect(workerRequestCaller(call.mock.calls[0][1] as never)?.executionScope).toBe('group')
  })

  it('leaves unbound workers without a caller and does not require a source', async () => {
    const { definition, call } = tool()
    const control: WorkerRequestControl = { scope: 'shared', authority: vi.fn(async () => undefined) }
    const bound = bindWorkerRequestTool(definition, control)
    expect((await bound.call({ worker_id: 'w-unbound', text: 'hello' }, {})).isError).toBe(false)
    expect(workerRequestCaller(call.mock.calls[0][1] as never)).toBeUndefined()
  })

  it('allows shared spawn_worker without resolving a caller', async () => {
    const { definition } = tool('spawn_worker')
    const control: WorkerRequestControl = { scope: 'shared', authority: vi.fn(async () => authority('group')) }
    const bound = bindWorkerRequestTool(definition, control)
    expect((await bound.call({ title: 't', prompt: 'p' }, {})).isError).toBe(false)
    expect(control.authority).not.toHaveBeenCalled()
  })

  it('keeps the fixed request authority in request scope', async () => {
    const { definition, call } = tool()
    const fixed = authority('request')
    const bound = bindWorkerRequestTool(definition, { scope: 'request', authority: async () => fixed })
    expect((await bound.call({ worker_id: 'w-any', text: 'hello' }, {})).isError).toBe(false)
    expect(workerRequestCaller(call.mock.calls[0][1] as never)).toBe(fixed)
  })
})
