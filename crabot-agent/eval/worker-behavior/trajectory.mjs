import { toolResultMessage } from './runtime.mjs'

export async function runTrajectory(condition, { sim, maxTurns, request, log }) {
  const c = condition
  const messages = [{ role: 'user', content: (c.idle ? '[已有会话与任务板上下文，不是新的人类请求]\n' : '') + c.scenario.initial + '\n\n' + c.scenario.objective }]
  if (c.idle) messages.push({ role: 'user', content: c.idle })
  const trajectory = []
  let status = 'turn_budget'
  if (c.summaryPrompt) {
    const folded = await request('compaction', { prompt: c.summaryPrompt, tools: [], messages })
    trajectory.push({ phase: 'compaction', ...folded })
    if (folded.status !== 'response' || !folded.response.text) status = 'missing'
    else messages.splice(0, messages.length, { role: 'user', content: c.summaryPrefix + folded.response.text }, { role: 'user', content: '继续完成原任务。' })
  }
  for (let turn = 0; turn < maxTurns && status !== 'missing'; turn++) {
    const result = await request('decision', { prompt: c.prompt, tools: c.tools, messages })
    const row = { turn, ...result, receipts: [] }
    trajectory.push(row)
    if (result.status !== 'response') { status = 'missing'; break }
    if (!['tool_use', 'end_turn'].includes(result.response.stopReason)) { status = 'incomplete_response'; break }
    const calls = result.response.toolUseBlocks ?? []
    messages.push({ role: 'assistant', content: [...(result.response.text ? [{ type: 'text', text: result.response.text }] : []), ...calls] })
    for (const call of calls) {
      const known = c.tools.some(t => t.name === call.name)
      const receipt = known ? await sim.call(call.name, call.input) : { output: 'TOOL_UNAVAILABLE', isError: true }
      row.receipts.push({ tool_use_id: call.id, ...receipt })
      log({ kind: 'tool_receipt', turn, call, receipt })
      if (receipt.harnessGap) { status = 'harness_gap'; break }
    }
    if (status === 'harness_gap') break
    if (calls.length) messages.push(toolResultMessage(row.receipts))
    if (sim.state.outcome) { status = 'ended'; break }
    // External events become visible at decision boundaries, including after tool calls.
    const next = sim.advance ? await sim.advance() : !calls.length ? await sim.event() : null
    if (next) {
      log({ kind: 'external_event', turn, content: next })
      messages.push({ role: 'user', content: next })
    } else if (!calls.length) { status = 'ended'; break }
  }
  return { status, trajectory, state: sim.state, findings: await sim.findings() }
}
