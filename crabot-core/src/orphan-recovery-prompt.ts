import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  formatOrphanTerminationCandidate,
  type OrphanTerminationCandidate,
} from './module-runtime-registry.js'

interface PromptOptions {
  interactive?: boolean
  ask?: (prompt: string) => Promise<string>
  write?: (message: string) => void
}

export function createOrphanTerminationConfirmer(
  options: PromptOptions = {},
): ((candidate: OrphanTerminationCandidate) => Promise<boolean>) | undefined {
  const interactive = options.interactive
    ?? (process.env.CRABOT_ORPHAN_RECOVERY_INTERACTIVE !== '0'
      && stdin.isTTY === true
      && stdout.isTTY === true)
  if (!interactive) return undefined

  const write = options.write ?? (message => stdout.write(message))
  const ask = options.ask ?? (async (prompt) => {
    const readline = createInterface({ input: stdin, output: stdout })
    try {
      return await readline.question(prompt)
    } finally {
      readline.close()
    }
  })

  return async (candidate) => {
    write(`${formatOrphanTerminationCandidate(candidate)}\n`)
    const answer = (await ask('Terminate this orphan process tree and continue startup? [y/N] ')).trim()
    return /^(?:y|yes)$/i.test(answer)
  }
}
