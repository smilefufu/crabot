import { createHash } from 'node:crypto'
import type { PaneSnapshot } from './driver.js'

export type InputProbe = 'empty' | 'pending' | 'unavailable'
export type InputMode = 'primary' | 'steering'
export type InputCommitDisposition = 'accepted' | 'not_pasted' | 'pending_in_ui'
export type InputProbePhase = 'before_paste' | 'after_paste'

export interface InputCommitDiagnostic {
  stage: 'before_paste' | 'after_paste' | 'after_enter'
  attempt?: number
  probe: InputProbe
  accepted: boolean
  pane_text_length: number
  pane_text_sha256: string
  dead?: boolean
  captured_at?: string
}

export interface InputCommitDriver {
  pasteText(text: string): Promise<void>
  /** Adapter-owned submission action for the currently probed input surface. */
  submit?(attempt?: number): Promise<void>
  /** @deprecated Test-only compatibility for the old fixed-Enter transaction. */
  sendEnter?(attempt?: number): Promise<void>
  capture(): Promise<PaneSnapshot>
}

export interface InputCommitOptions {
  settleTimeoutMs?: number
  intervalMs?: number
  beforeSideEffect?: (phase: 'paste' | 'enter') => void
  onDiagnostic?: (entry: InputCommitDiagnostic) => void | Promise<void>
}

/** Generic guarded paste transaction; implementation-specific UI semantics stay in callbacks. */
export async function commitInput(
  driver: InputCommitDriver,
  probe: (snapshot: PaneSnapshot, phase: InputProbePhase) => InputProbe,
  accepted: (snapshot: PaneSnapshot) => boolean,
  text: string,
  opts: InputCommitOptions = {},
): Promise<{ disposition: InputCommitDisposition; snapshot: PaneSnapshot }> {
  const timeoutMs = opts.settleTimeoutMs ?? 1_000
  const intervalMs = opts.intervalMs ?? 25
  let snapshot = await driver.capture()
  let beforePaste = probe(snapshot, 'before_paste')
  if (beforePaste === 'unavailable') {
    snapshot = await waitUntil(
      driver,
      timeoutMs,
      intervalMs,
      (current) => probe(current, 'before_paste') !== 'unavailable',
    )
    beforePaste = probe(snapshot, 'before_paste')
  }
  if (beforePaste !== 'empty') return { disposition: 'not_pasted', snapshot }

  await emitDiagnostic(opts, {
    stage: 'before_paste',
    probe: beforePaste,
    accepted: false,
    snapshot,
  })

  opts.beforeSideEffect?.('paste')
  await driver.pasteText(text)
  // Terminal renderers can expose a partial composer before the complete pasted text
  // is visible. Wait for the implementation to confirm ownership before Enter.
  snapshot = await waitUntil(driver, timeoutMs, intervalMs, (current) => probe(current, 'after_paste') === 'pending')
  let currentProbe = probe(snapshot, 'after_paste')
  await emitDiagnostic(opts, {
    stage: 'after_paste',
    probe: currentProbe,
    accepted: false,
    snapshot,
  })
  // Confirmed contract: a still-empty, footer-anchored composer means the target UI never exposed
  // ownership of this text. A successful tmux paste command alone is not receipt evidence; do not
  // invent pending_in_ui or press Enter without visible text ownership.
  if (currentProbe === 'empty') return { disposition: 'not_pasted', snapshot }
  if (currentProbe !== 'pending') return { disposition: 'pending_in_ui', snapshot }

  opts.beforeSideEffect?.('enter')
  await submit(driver, 1)
  snapshot = await waitUntil(
    driver,
    timeoutMs,
    intervalMs,
    (current) => accepted(current) || probe(current, 'after_paste') !== 'pending',
  )
  await emitDiagnostic(opts, {
    stage: 'after_enter',
    attempt: 1,
    probe: probe(snapshot, 'after_paste'),
    accepted: accepted(snapshot),
    snapshot,
  })
  if (accepted(snapshot)) return { disposition: 'accepted', snapshot }

  currentProbe = probe(snapshot, 'after_paste')
  if (currentProbe === 'pending') {
    opts.beforeSideEffect?.('enter')
    await submit(driver, 2)
    snapshot = await waitUntil(
      driver,
      timeoutMs,
      intervalMs,
      (current) => accepted(current) || probe(current, 'after_paste') !== 'pending',
    )
    await emitDiagnostic(opts, {
      stage: 'after_enter',
      attempt: 2,
      probe: probe(snapshot, 'after_paste'),
      accepted: accepted(snapshot),
      snapshot,
    })
    if (accepted(snapshot)) return { disposition: 'accepted', snapshot }
  }
  return { disposition: 'pending_in_ui', snapshot }
}

async function submit(driver: InputCommitDriver, attempt: number): Promise<void> {
  const action = driver.submit ?? driver.sendEnter
  if (!action) throw new Error('input commit driver has no submission action')
  await action(attempt)
}

async function emitDiagnostic(
  opts: InputCommitOptions,
  entry: Omit<InputCommitDiagnostic, 'pane_text_length' | 'pane_text_sha256' | 'dead' | 'captured_at'> & { snapshot: PaneSnapshot },
): Promise<void> {
  if (!opts.onDiagnostic) return
  const diagnostic: InputCommitDiagnostic = {
    stage: entry.stage,
    ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    probe: entry.probe,
    accepted: entry.accepted,
    pane_text_length: entry.snapshot.text.length,
    pane_text_sha256: createHash('sha256').update(entry.snapshot.text).digest('hex').slice(0, 16),
    ...(entry.snapshot.dead === undefined ? {} : { dead: entry.snapshot.dead }),
    ...(entry.snapshot.captured_at ? { captured_at: entry.snapshot.captured_at } : {}),
  }
  try {
    await opts.onDiagnostic(diagnostic)
  } catch {
    // Diagnostics must never change the delivery result.
  }
}

export async function waitForPaneChange(
  capture: () => Promise<PaneSnapshot>,
  baselineText: string,
  timeoutMs = 500,
  intervalMs = 25,
): Promise<PaneSnapshot> {
  const deadline = Date.now() + timeoutMs
  let snapshot = await capture()
  while (snapshot.text === baselineText && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    snapshot = await capture()
  }
  return snapshot
}

async function waitUntil(
  driver: InputCommitDriver,
  timeoutMs: number,
  intervalMs: number,
  predicate: (snapshot: PaneSnapshot) => boolean,
): Promise<PaneSnapshot> {
  const deadline = Date.now() + timeoutMs
  let snapshot = await driver.capture()
  while (!predicate(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    snapshot = await driver.capture()
  }
  return snapshot
}
