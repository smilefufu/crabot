import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { IncarnationId } from '../types.js'

const HANDOFF_SUMMARY_MAX_CHARS = 8_000
const HANDOFF_TASK_CONTEXT_MAX_CHARS = 2_000
const HANDOFF_EVIDENCE_TRUNCATED = 'evidence: truncated to retain the most recent structured activity'

export type HandoffEvidenceSource = 'native_session' | 'persisted_activity' | 'ledger'

export interface HandoffEvidenceInput {
  readonly source: HandoffEvidenceSource
  /** Opaque Harness identifier, never a source-session or host filesystem path. */
  readonly reference: string
  readonly summary: string
}

/**
 * Private Harness artifact. The persisted shape follows protocol-agent-v3 §3 exactly; it never
 * asks a Worker to create a workspace file during a failure or handoff boundary.
 */
export interface HandoffPackage {
  readonly package_id: string
  readonly worker_id: string
  readonly source_incarnation_id: IncarnationId
  readonly workspace: string
  readonly created_at: string
  readonly sources: HandoffEvidenceSource[]
  readonly evidence: Array<{ source: HandoffEvidenceSource; reference: string }>
  readonly unavailable: string[]
  readonly summary: string
}

function packagePath(workersDir: string, workerId: string, packageId: string): string {
  return join(workersDir, workerId, 'handoffs', `${packageId}.json`)
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  await fs.mkdir(dirname(path), { recursive: true })
  try {
    await fs.writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, path)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function writeHandoffPackage(params: {
  readonly workersDir: string
  readonly workerId: string
  readonly sourceIncarnationId: IncarnationId
  readonly workspace: string
  readonly createdAt: string
  readonly evidence: ReadonlyArray<HandoffEvidenceInput>
  readonly unavailable?: ReadonlyArray<string>
}): Promise<HandoffPackage> {
  const packageId = randomUUID()
  const { retained, truncated } = boundedEvidence(params.evidence)
  const handoff: HandoffPackage = {
    package_id: packageId,
    worker_id: params.workerId,
    source_incarnation_id: params.sourceIncarnationId,
    workspace: params.workspace,
    created_at: params.createdAt,
    sources: [...new Set(retained.map((item) => item.source))],
    evidence: retained.map(({ source, reference }) => ({ source, reference })),
    unavailable: [...new Set([
      ...(params.unavailable ?? []),
      ...(truncated ? [HANDOFF_EVIDENCE_TRUNCATED] : []),
    ])],
    summary: retained.length > 0
      ? retained.map(({ source, reference, summary }) => `[${source}:${reference}] ${summary}`).join('\n')
      : 'No structured source evidence was available.',
  }
  await writeAtomic(packagePath(params.workersDir, params.workerId, packageId), JSON.stringify(handoff, null, 2) + '\n')
  return handoff
}

/** The target gets a bounded projection, never a filesystem path or terminal capture instruction. */
export function renderHandoffPrompt(handoff: HandoffPackage, continuationInput: string): string {
  return [
    'A previous worker incarnation is unavailable. The following is a Harness-generated, read-only handoff derived from structured session evidence. Continue the task; do not look for or create a handoff file in the workspace.',
    `Handoff package: ${handoff.package_id}`,
    `Evidence references: ${handoff.evidence.map((item) => `${item.source}:${item.reference}`).join(', ') || '(none)'}`,
    '',
    handoff.summary,
    ...(handoff.unavailable.length > 0 ? ['', `Unavailable evidence: ${handoff.unavailable.join('; ')}`] : []),
    '',
    `Continuation input: ${continuationInput}`,
  ].join('\n')
}

function boundedEvidence(evidence: ReadonlyArray<HandoffEvidenceInput>): {
  retained: HandoffEvidenceInput[]
  truncated: boolean
} {
  const candidates = evidence.flatMap((item) => {
    const summary = item.summary.trim()
    return summary && item.reference ? [{ ...item, summary }] : []
  })
  const taskContext = candidates.filter((item) =>
    item.source === 'ledger' && (item.reference.startsWith('task:') || item.reference.endsWith(':outcome')),
  )
  const activity = candidates.filter((item) => !taskContext.includes(item))
  const retained: HandoffEvidenceInput[] = []
  let used = 0
  let truncated = false

  const taskContextBudget = Math.min(HANDOFF_TASK_CONTEXT_MAX_CHARS, HANDOFF_SUMMARY_MAX_CHARS)
  for (let index = 0; index < taskContext.length; index += 1) {
    const item = taskContext[index]
    const budget = Math.floor((taskContextBudget - used) / (taskContext.length - index))
    const fitted = fitEvidence(item, budget, 'head')
    if (!fitted) {
      truncated = true
      continue
    }
    retained.push(fitted.item)
    used += fitted.cost
    truncated ||= fitted.truncated
  }

  const recent: HandoffEvidenceInput[] = []
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const fitted = fitEvidence(activity[index], HANDOFF_SUMMARY_MAX_CHARS - used, 'tail')
    if (!fitted) {
      truncated = true
      break
    }
    recent.unshift(fitted.item)
    used += fitted.cost
    if (fitted.truncated) {
      truncated = true
      break
    }
  }
  if (recent.length < activity.length) truncated = true
  return { retained: [...retained, ...recent], truncated }
}

function fitEvidence(
  item: HandoffEvidenceInput,
  budget: number,
  direction: 'head' | 'tail',
): { item: HandoffEvidenceInput; cost: number; truncated: boolean } | undefined {
  const overhead = item.source.length + item.reference.length + 8
  const summaryBudget = budget - overhead
  if (summaryBudget <= 0) return undefined
  const truncated = item.summary.length > summaryBudget
  const summary = truncated
    ? direction === 'head' ? item.summary.slice(0, summaryBudget) : item.summary.slice(-summaryBudget)
    : item.summary
  return {
    item: { ...item, summary },
    cost: summary.length + overhead,
    truncated,
  }
}
