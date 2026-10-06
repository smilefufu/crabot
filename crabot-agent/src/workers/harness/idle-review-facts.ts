import { sha256CanonicalJson } from 'crabot-shared'

/** Process-local admission evidence, not a Worker or business completion state. */
export interface IdleReviewFacts {
  readonly fingerprint: string
  readonly canSkip: boolean
}

export interface ReviewBackgroundFacts extends IdleReviewFacts {
  readonly active: boolean
}

export function reviewFingerprint(value: unknown): string {
  return sha256CanonicalJson(JSON.parse(JSON.stringify(value)))
}
