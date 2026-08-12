import { afterEach, describe, expect, it } from 'vitest'
import { buildChildEnv } from '../../src/core/runtime-env.js'

describe('Agent child environment', () => {
  const original = process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER

  afterEach(() => {
    if (original === undefined) delete process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER
    else process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = original
  })

  it('does not inherit or reintroduce the runtime bearer', () => {
    process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = 'runtime-secret-marker'

    const env = buildChildEnv({ CHILD_MARKER: 'present', CRABOT_CORE_AGENT_RUNTIME_BEARER: 'attempted-override' })

    expect(env.CHILD_MARKER).toBe('present')
    expect(env.CRABOT_CORE_AGENT_RUNTIME_BEARER).toBeUndefined()
    expect(Object.values(env)).not.toContain('runtime-secret-marker')
  })
})
