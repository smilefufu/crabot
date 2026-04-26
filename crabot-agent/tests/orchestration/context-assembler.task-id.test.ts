import { describe, it, expect } from 'vitest'
import { ContextAssembler } from '../../src/orchestration/context-assembler.js'
import { createMockRpcClient, defaultOrchestrationConfig } from './_helpers.js'

interface RpcCall {
  method: string
  params: any
}

function makeAssembler() {
  const calls: RpcCall[] = []
  const rpcClient = createMockRpcClient()
  rpcClient.call.mockImplementation(async (_port: number, method: string, params: any) => {
    calls.push({ method, params })
    if (method === 'search_long_term') return { results: [] }
    if (method === 'search_short_term') return { results: [] }
    if (method === 'list_tasks') return { items: [] }
    if (method === 'list_modules') return { modules: [] }
    if (method === 'lookup_friend') return { friends: [] }
    if (method === 'list_scene_profiles_by_memory') return { results: [] }
    if (method === 'get_scene_profile') return null
    return {}
  })
  const assembler = new ContextAssembler(
    rpcClient as any,
    'agent-test',
    defaultOrchestrationConfig,
    async () => 19001,
    async () => 19002,
  )
  return { assembler, calls }
}

const baseParams = {
  channel_id: 'wechat-1' as any,
  session_id: 'sess_1' as any,
  sender_id: 'fri_zhang',
  message: '帮我做 X',
  friend_id: 'fri_zhang',
  session_type: 'private' as const,
}

const memoryPermissions = { read_min_visibility: 'public', read_accessible_scopes: [] } as any

describe('ContextAssembler.assembleWorkerContext: task_id propagation to search_long_term', () => {
  it('passes task_id from AssembleParams down to memory.search_long_term call', async () => {
    const { assembler, calls } = makeAssembler()
    await assembler.assembleWorkerContext({ ...baseParams, task_id: 't_xyz' }, memoryPermissions)
    const searchCall = calls.find(c => c.method === 'search_long_term')
    expect(searchCall?.params?.task_id).toBe('t_xyz')
  })

  it('omits task_id when not provided in AssembleParams (backward compat)', async () => {
    const { assembler, calls } = makeAssembler()
    await assembler.assembleWorkerContext(baseParams, memoryPermissions)
    const searchCall = calls.find(c => c.method === 'search_long_term')
    expect(searchCall).toBeDefined()
    expect('task_id' in (searchCall?.params ?? {})).toBe(false)
  })
})
