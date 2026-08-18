import type { PaneSnapshot } from './driver.js'

export type InputProbe = 'empty' | 'pending' | 'unavailable'
export type InputMode = 'primary' | 'steering'
export type InputCommitDisposition = 'accepted' | 'not_pasted' | 'pending_in_ui'
export type InputProbePhase = 'before_paste' | 'after_paste'

export interface InputCommitDriver {
  pasteText(text: string): Promise<void>
  sendEnter(): Promise<void>
  capture(): Promise<PaneSnapshot>
}

export interface InputCommitOptions {
  settleTimeoutMs?: number
  intervalMs?: number
  beforeSideEffect?: (phase: 'paste' | 'enter') => void
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

  opts.beforeSideEffect?.('paste')
  await driver.pasteText(text)
  snapshot = await waitUntil(driver, timeoutMs, intervalMs, (current) => probe(current, 'after_paste') !== 'empty')
  let currentProbe = probe(snapshot, 'after_paste')
  // Confirmed contract: a still-empty, footer-anchored composer means the target UI never exposed
  // ownership of this text. A successful tmux paste command alone is not receipt evidence; do not
  // invent pending_in_ui or press Enter without visible text ownership.
  if (currentProbe === 'empty') return { disposition: 'not_pasted', snapshot }
  if (currentProbe !== 'pending') return { disposition: 'pending_in_ui', snapshot }

  opts.beforeSideEffect?.('enter')
  await driver.sendEnter()
  snapshot = await waitUntil(
    driver,
    timeoutMs,
    intervalMs,
    (current) => accepted(current) || probe(current, 'after_paste') !== 'pending',
  )
  if (accepted(snapshot)) return { disposition: 'accepted', snapshot }

  currentProbe = probe(snapshot, 'after_paste')
  if (currentProbe === 'pending') {
    opts.beforeSideEffect?.('enter')
    await driver.sendEnter()
    snapshot = await waitUntil(
      driver,
      timeoutMs,
      intervalMs,
      (current) => accepted(current) || probe(current, 'after_paste') !== 'pending',
    )
    if (accepted(snapshot)) return { disposition: 'accepted', snapshot }
  }
  return { disposition: 'pending_in_ui', snapshot }
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
