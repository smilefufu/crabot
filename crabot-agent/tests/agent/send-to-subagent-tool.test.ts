import { describe, it, expect, vi } from 'vitest'
import { createSendToSubagentTool } from '../../src/agent/send-to-subagent-tool.js'
import { filterToolsForSubAgent } from '../../src/agent/subagent-tool-filter.js'

describe('send_to_subagent tool boundary', () => {
  it.each([{ agent_id: 'shell_1', text: 'hello' }, { agent_id: 'agent_', text: 'hello' },
    { agent_id: 'agent_1', text: '  ' }, { agent_id: 'agent_1', text: 12 }])('rejects malformed input %j before routing', async input => {
    const route = vi.fn()
    expect((await createSendToSubagentTool(route).call(input, {})).isError).toBe(true)
    expect(route).not.toHaveBeenCalled()
  })
  it('uses only the trusted context and is excluded from child toolsets', async () => {
    const route = vi.fn(async () => ({ isError: false, output: 'queued' }))
    const tool = createSendToSubagentTool(route)
    const context = { worker_subagent: { worker_id: 'own', caller_instance_id: 'own#1' } }
    await tool.call({ agent_id: 'agent_1', text: 'keep existing output', worker_id: 'spoof' }, context)
    expect(route).toHaveBeenCalledWith('agent_1', 'keep existing output', context)
    expect(filterToolsForSubAgent([tool], { file_system: true, shell: true, task_intel: true, crab_memory: true, crab_messaging: true }, [])).toEqual([])
  })
})
