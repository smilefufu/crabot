import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { IncarnationId } from '../types.js'

const HANDOFF_SUMMARY_MAX_CHARS = 8_000

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
  const retained = boundedEvidence(params.evidence)
  const handoff: HandoffPackage = {
    package_id: packageId,
    worker_id: params.workerId,
    source_incarnation_id: params.sourceIncarnationId,
    workspace: params.workspace,
    created_at: params.createdAt,
    sources: [...new Set(retained.map((item) => item.source))],
    evidence: retained.map(({ source, reference }) => ({ source, reference })),
    unavailable: [...new Set(params.unavailable ?? [])],
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

function boundedEvidence(evidence: ReadonlyArray<HandoffEvidenceInput>): HandoffEvidenceInput[] {
  const retained: HandoffEvidenceInput[] = []
  let used = 0
  for (const item of evidence) {
    const summary = item.summary.trim()
    if (!summary || !item.reference) continue
    const cost = summary.length + item.source.length + item.reference.length + 8
    if (retained.length > 0 && used + cost > HANDOFF_SUMMARY_MAX_CHARS) break
    retained.push({ ...item, summary })
    used += cost
  }
  return retained
}
