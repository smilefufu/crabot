import { createInterface } from 'node:readline/promises'

export async function promptYesNo(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question(`${message} Type YES to confirm: `)).trim()
    return answer === 'YES'
  } finally {
    rl.close()
  }
}
