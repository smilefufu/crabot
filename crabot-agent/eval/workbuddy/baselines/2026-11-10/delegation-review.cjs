const { createHash } = require('node:crypto')
const fingerprint = x => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const NAMES = new Set(['spawn_worker', 'send_to_worker'])
const REVIEW_PREFIX = 'DELEGATION_FIDELITY_REVIEW\n'

function publicMessages(messages) {
  return messages.map(m => ({ ...m, ...(Array.isArray(m.content) ? {
    content: m.content.filter(b => !['thinking', 'redacted_thinking', 'reasoning'].includes(b.type)),
  } : {}) })).map(({ rawReasoning, reasoning_content, ...m }) => m)
}

function parse(text, calls) {
  const verdict = JSON.parse(text)
  if (!['allow', 'revise', 'uncertain'].includes(verdict.verdict) || !Array.isArray(verdict.issues) ||
      (verdict.verdict === 'allow') !== (verdict.issues.length === 0)) throw Error('Invalid review verdict')
  const ids = new Set(calls.map(c => c.id))
  for (const issue of verdict.issues) {
    if (!Array.isArray(issue.call_ids) || !issue.call_ids.length || issue.call_ids.some(id => !ids.has(id)) ||
        !['source_quote', 'handoff_quote', 'impact'].every(k => typeof issue[k] === 'string') ||
        !issue.source_quote || !issue.impact) throw Error('Invalid review attribution/evidence')
  }
  return verdict
}

function createReview({ invoke, observe, originalSource }) {
  let consecutiveRejects = 0
  const technicalErrors = []
  async function prepare({ systemPrompt, messages, tools, calls, signal }) {
    const dispatches = calls.filter(c => NAMES.has(c.name))
    if (!dispatches.length) return tools
    const snapshot = {
      originalSource,
      managerSystem: systemPrompt,
      managerMessages: publicMessages(messages),
      tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      proposedCalls: structuredClone(calls),
    }
    const before = fingerprint(snapshot)
    let verdict, failure
    try {
      if (consecutiveRejects >= 2) {
        verdict = { verdict: 'uncertain', issues: dispatches.map(c => ({ call_ids: [c.id], source_quote: '已用尽本次连续修订机会', handoff_quote: '', impact: '停止继续派工，保留结果并报告未解决的需求分歧。' })) }
      } else {
        verdict = parse(await invoke(snapshot, signal), dispatches)
      }
      const current = { ...snapshot, managerSystem: systemPrompt, managerMessages: publicMessages(messages), proposedCalls: structuredClone(calls) }
      if (fingerprint(current) !== before || signal?.aborted) throw Error('Review input changed or cancelled')
    } catch (error) {
      failure = String(error)
      technicalErrors.push(failure)
    }
    observe({ type: 'delegation_review', snapshotSha256: before, callIds: dispatches.map(c => c.id), verdict, technical_error: failure })
    if (!failure && verdict.verdict === 'allow') { consecutiveRejects = 0; return tools }
    consecutiveRejects++
    // Reject the batch atomically, but attribute evidence by exact call ID and unchanged input.
    return tools.map(tool => !NAMES.has(tool.name) ? tool : { ...tool, call: async input => {
      const matching = dispatches.filter(c => c.name === tool.name && fingerprint(c.input) === fingerprint(input))
      const ids = new Set(matching.map(c => c.id))
      return { isError: true, output: JSON.stringify({ status: failure ? 'review_unavailable' : verdict.verdict,
        dispatched: false, batch_deferred: true, affected_call_ids: [...ids],
        issues: (verdict?.issues ?? []).filter(i => i.call_ids.some(id => ids.has(id))),
        other_call_issues: (verdict?.issues ?? []).filter(i => !i.call_ids.some(id => ids.has(id))),
        technical_error: failure,
        instruction: failure ? '复核接口技术失败，本次未派工；如实报告，不能宣称任务完成。' : '本批派工尚未执行。结合全批分工修订后重新派发；同一问题最多一次修订，仍有争议则报告真实缺口。',
      }) }
    } })
  }
  return { prepare, technicalErrors }
}

module.exports = { createReview, parse, fingerprint, REVIEW_PREFIX }
