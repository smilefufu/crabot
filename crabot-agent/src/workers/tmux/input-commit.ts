import type { PaneSnapshot } from './driver.js'

export type InputProbe = 'empty' | 'pending' | 'unavailable'
export type InputMode = 'primary' | 'steering'
export type InputCommitDisposition = 'accepted' | 'not_pasted' | 'pending_in_ui'

export interface InputCommitDriver {
  pasteText(text: string): Promise<void>
  sendEnter(): Promise<void>
  capture(): Promise<PaneSnapshot>
}

/**
 * Generic paste/commit transaction. The caller supplies implementation-specific probes; this
 * layer deliberately has no knowledge of CLI text, native transcripts, or control state.
 */
export async function commitInput(
  driver: InputCommitDriver,
  probe: (snapshot: PaneSnapshot) => InputProbe,
  accepted: (snapshot: PaneSnapshot) => boolean,
  text: string,
): Promise<{ disposition: InputCommitDisposition; snapshot: PaneSnapshot }> {
  let snapshot = await driver.capture()
  if (probe(snapshot) !== 'empty') return { disposition: 'not_pasted', snapshot }

  await driver.pasteText(text)
  snapshot = await driver.capture()
  if (probe(snapshot) !== 'pending') return { disposition: 'pending_in_ui', snapshot }

  await driver.sendEnter()
  snapshot = await driver.capture()
  if (accepted(snapshot)) return { disposition: 'accepted', snapshot }
  if (probe(snapshot) === 'pending') {
    await driver.sendEnter()
    snapshot = await driver.capture()
    if (accepted(snapshot)) return { disposition: 'accepted', snapshot }
  }
  return { disposition: 'pending_in_ui', snapshot }
}
