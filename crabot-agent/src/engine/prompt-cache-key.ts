import { createHash } from 'crypto'

export function buildPromptCacheKey(model: string, systemPrompt: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['crabot-prompt-cache-v1', model, systemPrompt]), 'utf8')
    .digest('hex')
}
