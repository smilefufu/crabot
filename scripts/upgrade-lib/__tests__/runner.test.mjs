import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScript } from '../runner.mjs'

describe('runScript', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crabot-runner-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs a .mjs script and captures stdout/stderr/exit', async () => {
    const script = join(dir, 'ok.mjs')
    writeFileSync(script, `
      const arg = process.argv.find(a => a.startsWith('--data-dir='))
      console.log('hi from script:', arg)
      console.error('warn line')
      process.exit(0)
    `)
    const { exitCode, stdout, stderr } = await runScript(script, '/tmp/some-data')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('hi from script: --data-dir=/tmp/some-data')
    expect(stderr).toContain('warn line')
  })

  it('returns non-zero exit code when script fails', async () => {
    const script = join(dir, 'fail.mjs')
    writeFileSync(script, `console.error('bad'); process.exit(2)`)
    const { exitCode, stderr } = await runScript(script, '/tmp/x')
    expect(exitCode).toBe(2)
    expect(stderr).toContain('bad')
  })

  it('throws on unsupported extension', async () => {
    const script = join(dir, 'weird.sh')
    writeFileSync(script, '#!/bin/sh\necho hi\n')
    chmodSync(script, 0o755)
    await expect(runScript(script, '/tmp/x')).rejects.toThrow(/unsupported/i)
  })
})
