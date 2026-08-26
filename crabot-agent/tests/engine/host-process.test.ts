import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runHostProcess } from '../../src/engine/host-process'
import { resolveBashPath } from '../../src/utils/resolve-bash-path'

const bashPath = resolveBashPath()

function shell(command: string, overrides: Partial<Parameters<typeof runHostProcess>[0]> = {}) {
  if (bashPath === null) throw new Error('bash is required for host-process integration tests')
  return runHostProcess({
    argv: [bashPath, '-c', command],
    limits: { timeoutMs: 2_000, stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, killGraceMs: 25 },
    ...overrides,
  })
}

describe('runHostProcess', () => {
  const temporaryPaths: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryPaths.splice(0).map((filePath) => fs.rm(filePath, { recursive: true, force: true })))
  })

  it('captures normal and non-zero shell exits without involving the Agent process', async () => {
    const normal = await shell('printf out; printf err >&2')
    expect(normal).toMatchObject({ kind: 'exit', exitCode: 0, stdout: 'out', stderr: 'err' })

    const nonzero = await shell('exit 7')
    expect(nonzero).toMatchObject({ kind: 'exit', exitCode: 7 })
  })

  it('terminates the entire process group on timeout and leaves later calls usable', async () => {
    const pidFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'host-process-tree-')), 'grandchild.pid')
    temporaryPaths.push(path.dirname(pidFile))
    const childProgram = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    const timedOut = await shell(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childProgram)} & wait`,
      { limits: { timeoutMs: 500, stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, killGraceMs: 100 } },
    )

    expect(timedOut.kind).toBe('timed_out')
    const grandchildPid = Number(await fs.readFile(pidFile, 'utf8'))
    expect(Number.isInteger(grandchildPid)).toBe(true)
    expect(() => process.kill(grandchildPid, 0)).toThrow()

    const later = await shell('printf still-running')
    expect(later).toMatchObject({ kind: 'exit', exitCode: 0, stdout: 'still-running' })
  })

  it('reports abort and bounded-output failures while retaining the collected tail', async () => {
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 25)
    const aborted = await shell('sleep 5', { abortSignal: controller.signal })
    clearTimeout(abortTimer)
    expect(aborted.kind).toBe('aborted')

    const limited = await shell(
      "printf 'HEAD_MARKER\\n'; printf 'a%.0s' {1..120000}; printf 'END_MARKER\\n'",
      { limits: { timeoutMs: 2_000, stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, killGraceMs: 25 } },
    )
    expect(limited.kind).toBe('output_limit')
    expect(limited.stdout).not.toContain('HEAD_MARKER')
    expect(Buffer.byteLength(limited.stdout, 'utf8')).toBeLessThanOrEqual(64 * 1024)
  })
})
