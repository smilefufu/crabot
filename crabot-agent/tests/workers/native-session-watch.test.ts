import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { watchNativeSessionFile } from '../../src/workers/native-session-watch'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function waitUntil(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('native session watch timed out')
}

describe('watchNativeSessionFile', () => {
  it('文件出现或追加时仅发出读取机会，并且关闭后不再回调', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'native-session-watch-test-'))
    dirs.push(dir)
    const path = join(dir, 'session.jsonl')
    let signals = 0
    const stop = watchNativeSessionFile(() => path, () => { signals++ })

    await fs.writeFile(path, '{"first":true}\n')
    await waitUntil(() => signals > 0)
    const beforeStop = signals
    stop()
    await fs.appendFile(path, '{"second":true}\n')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(signals).toBe(beforeStop)
  })
})
