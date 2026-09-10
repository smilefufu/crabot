import { afterEach, describe, expect, it } from 'vitest'
import { buildChildEnv, withChildExecutionEnv } from '../../src/core/runtime-env.js'

describe('Agent child environment', () => {
  const originalRuntimeBearer = process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER
  const originalToken = process.env.CRABOT_TOKEN

  afterEach(() => {
    if (originalRuntimeBearer === undefined) delete process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER
    else process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = originalRuntimeBearer
    if (originalToken === undefined) delete process.env.CRABOT_TOKEN
    else process.env.CRABOT_TOKEN = originalToken
  })

  it('does not inherit or reintroduce the runtime bearer', () => {
    process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = 'runtime-secret-marker'

    const env = buildChildEnv({ CHILD_MARKER: 'present', CRABOT_CORE_AGENT_RUNTIME_BEARER: 'attempted-override' })

    expect(env.CHILD_MARKER).toBe('present')
    expect(env.CRABOT_CORE_AGENT_RUNTIME_BEARER).toBeUndefined()
    expect(Object.values(env)).not.toContain('runtime-secret-marker')
  })

  it('keeps concurrent execution credentials isolated without mutating process.env', async () => {
    process.env.CRABOT_TOKEN = 'ambient-token'
    const read = (token: string) => withChildExecutionEnv(
      { CRABOT_TOKEN: token, CRABOT_ACTOR: 'agent' },
      async () => {
        await Promise.resolve()
        const env = buildChildEnv()
        return [env.CRABOT_TOKEN, env.CRABOT_ACTOR]
      },
    )

    await expect(Promise.all([read('token-a'), read('token-b')])).resolves.toEqual([
      ['token-a', 'agent'],
      ['token-b', 'agent'],
    ])
    expect(process.env.CRABOT_TOKEN).toBe('ambient-token')
    expect(buildChildEnv().CRABOT_TOKEN).toBeUndefined()
  })
})
