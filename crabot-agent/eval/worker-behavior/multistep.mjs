import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { hash, promptFor, toolDefinitions, idlePrompt, connection, generate, load, skill, repo } from './runtime.mjs'
import { createSimulation } from './simulation.mjs'
import { createJournal, readJournal, auditSlots } from './journal.mjs'
import { runTrajectory } from './trajectory.mjs'

const scenariosText = fs.readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8')
const spec = JSON.parse(scenariosText)
assert.equal(hash(scenariosText), '63206bdc666d1984624f4f4d6d4ed1f81aeb76bcaf30f3486f1a2b0b77a5ddf4')
const out = process.env.REPLAY_OUTPUT_DIR
assert(out, 'REPLAY_OUTPUT_DIR required')
const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const evaluatorSources = ['multistep.mjs', 'runtime.mjs', 'simulation.mjs', 'manager-simulation.mjs', 'journal.mjs', 'trajectory.mjs']
const sourceHashes = () => Object.fromEntries(evaluatorSources.map(name => [name, hash(fs.readFileSync(new URL(name, import.meta.url), 'utf8'))]))
const runtimeFiles = ['manager/tools/worker-tools.js', 'manager/tools/workboard-tools.js', 'manager/tools/project-doc-tools.js',
  'manager/workboard-store.js', 'workers/harness/worker-turn-store.js', 'workers/harness/workspace-git-inspector.js',
  'workers/trace/activity-projection.js', 'engine/openai-adapter.js', 'engine/stream-processor.js', 'engine/types.js',
  'mcp/crab-memory.js', 'agent/mcp-tool-bridge.js']
const runtimeHashes = () => Object.fromEntries(runtimeFiles.map(name => [name, hash(fs.readFileSync(path.join(repo, 'crabot-agent/dist', name), 'utf8'))]))

if (process.argv[2] === 'prepare') {
  const split = process.argv[3]
  assert(['development', 'holdout', 'revision-development', 'revision-diagnostic', 'manager-diagnostic', 'manager-memory-diagnostic'].includes(split), 'Select a frozen split')
  fs.mkdirSync(out, { recursive: true })
  const revision = split.startsWith('revision-') || split.startsWith('manager-')
  const cases = spec.cases.filter(c => {
    if (split === 'manager-diagnostic') return c.role.startsWith('manager')
    if (split === 'manager-memory-diagnostic') return c.id === 'replace-worker'
    if (split === 'revision-diagnostic') return ['missing-source', 'real-denial'].includes(c.id)
    return c.split === split.replace('revision-', '')
  })
  const variants = revision ? ['candidate'] : ['baseline', 'candidate']
  const conditions = cases.flatMap(c => variants.map(variant => {
    const profile = c.role === 'manager-summary' ? load('crabot-agent/src/engine/context-manager.ts', variant).createManagerCompactionProfile() : null
    return { id: `${c.id}-${variant}`, scenario: c, variant, prompt: promptFor(c.role, variant), tools: toolDefinitions(c.role),
      skillText: skill(variant), idle: c.role === 'manager-idle' ? idlePrompt(variant) : null,
      summaryPrompt: profile?.summarySystemPrompt ?? null, summaryPrefix: profile?.summaryMessagePrefix ?? null }
  }))
  const order = cases.flatMap((c, i) => Array.from({ length: spec.repetitions }, (_, r) => {
    const sampleVariants = !revision && (i + r) % 2 === 0 ? [...variants].reverse() : variants
    return sampleVariants.map(variant => ({ id: `${c.id}-${variant}-${r + 1}`, condition: `${c.id}-${variant}` }))
  })).flat()
  save('conditions.json', conditions)
  save('plan.json', { baseline: spec.baseline_commit, cases_hash: hash(scenariosText), conditions_hash: hash(conditions),
    evaluator_hashes: sourceHashes(), runtime_hashes: runtimeHashes(), evaluation_scope: split,
    order, max_turns: spec.max_turns, real_generated_command_executions: 0, attempts_per_request: 1 })
  for (const name of evaluatorSources) fs.copyFileSync(new URL(name, import.meta.url), path.join(out, name), fs.constants.COPYFILE_EXCL)
  console.log(JSON.stringify({ prepared: order.length, split }))
} else if (process.argv[2] === 'run') {
  const plan = JSON.parse(fs.readFileSync(path.join(out, 'plan.json'), 'utf8'))
  const conditions = JSON.parse(fs.readFileSync(path.join(out, 'conditions.json'), 'utf8'))
  assert.equal(hash(conditions), plan.conditions_hash)
  assert.deepEqual(sourceHashes(), plan.evaluator_hashes, 'Evaluator changed after freezing; use a new batch')
  assert.deepEqual(runtimeHashes(), plan.runtime_hashes, 'Production tool runtime changed after freezing')
  const logFile = path.join(out, 'results.jsonl')
  const previous = readJournal(logFile)
  assert(!previous.some(r => r.kind === 'truncated_record'), 'Partial journal: retain it and audit; do not append to a broken record')
  const started = new Set(previous.map(r => r.id))
  const remaining = plan.order.filter(slot => !started.has(slot.id))
  const conn = await connection()
  if (!fs.existsSync(path.join(out, 'connection.json'))) save('connection.json', { endpoint: conn.endpoint, model: conn.model_id, thinking: 'off', max_tokens: 6000 })
  const journal = createJournal(logFile)
  let index = 0
  async function runSlot(slot) {
    const c = conditions.find(c => c.id === slot.condition)
    const log = value => journal({ id: slot.id, ...value })
    log({ kind: 'started', at: new Date().toISOString() })
    console.log(JSON.stringify({ started: slot.id }))
    let sim
    let requestIndex = 0
    try {
      sim = await createSimulation(c.scenario, c.variant, c.skillText)
      const request = async (phase, condition) => {
        const request_id = `${slot.id}:${requestIndex++}`
        log({ kind: 'request_started', request_id, phase, at: new Date().toISOString(), input_hash: hash(condition) })
        const result = await generate(condition, conn)
        log({ kind: 'request_result', request_id, phase, at: new Date().toISOString(), ...result })
        return result
      }
      const result = await runTrajectory(c, { sim, maxTurns: plan.max_turns, request, log })
      log({ kind: 'result', ...result })
      console.log(JSON.stringify({ finished: slot.id, status: result.status, unsupported: result.findings.unsupported.length, turns: result.trajectory.length }))
    } catch (error) {
      log({ kind: 'result', status: 'harness_error', error: error.message })
      throw error
    } finally { await sim?.dispose?.() }
  }
  async function consume() { while (index < remaining.length) await runSlot(remaining[index++]) }
  const settled = await Promise.allSettled([consume(), consume(), consume()])
  for (const result of settled) if (result.status === 'rejected') throw result.reason
} else if (process.argv[2] === 'report') {
  const rows = readJournal(path.join(out, 'results.jsonl'))
  const plan = JSON.parse(fs.readFileSync(path.join(out, 'plan.json'), 'utf8'))
  const results = auditSlots(plan, rows)
  save('audit.json', { results, real_generated_command_executions: 0, quality_passes: null,
    truncated_records: rows.filter(r => r.kind === 'truncated_record').length })
  console.log(JSON.stringify(results))
} else throw new Error('Use prepare <split>, run or report; historical recovery uses its archived evaluator')
