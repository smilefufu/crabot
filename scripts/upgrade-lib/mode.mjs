import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function detectMode(crabotHome) {
  return existsSync(join(crabotHome, '.git')) ? 'source' : 'release'
}
