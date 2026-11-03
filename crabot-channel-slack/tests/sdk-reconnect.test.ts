import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

describe('real SDK reconnect failure boundary', () => {
  it.each([
    ['transient', { requests: 3, recovered: true, terminal: true }],
    ['permanent', { requests: 2, recovered: false, terminal: true }],
    ['stop', { requests: 1, recovered: false, terminal: true }],
    ['startup', { requests: 1, recovered: false, terminal: false, startupError: 'slack_webapi_request_error' }],
  ])('%s does not escape as an unhandled rejection', (scenario, expected) => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/sdk-reconnect.mjs', import.meta.url)), scenario as string], { encoding: 'utf8', timeout: 6000 })
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout.trim())).toEqual(expected)
    expect(child.stderr).not.toContain('WebAPIRequestError')
  })
})
