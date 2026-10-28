import { afterEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { buildChildEnv, buildMcpChildEnv, scrubChildEnv, withChildExecutionEnv } from '../../src/core/runtime-env.js'

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

  it('never gives script or MCP children Admin signing or human access credentials', () => {
    const secrets = {
      CRABOT_JWT_SECRET: 'admin-signing-marker',
      CRABOT_ADMIN_PASSWORD: 'admin-password-marker',
      CRABOT_INTERNAL_TOKEN: 'admin-internal-marker',
    }
    const previous = Object.fromEntries(Object.keys(secrets).map(key => [key, process.env[key]]))
    Object.assign(process.env, secrets)
    try {
      const env = withChildExecutionEnv({ ...secrets, CRABOT_TOKEN: 'scoped-agent-token' }, () => buildChildEnv(secrets))
      for (const key of Object.keys(secrets)) expect(env[key], key).toBeUndefined()
      expect(env.CRABOT_TOKEN).toBe('scoped-agent-token')
      expect(scrubChildEnv({ ...secrets, CHILD_MARKER: 'kept' })).toEqual({ CHILD_MARKER: 'kept' })
      expect(buildChildEnv({ crabot_jwt_secret: 'case-variant-secret' }).crabot_jwt_secret).toBeUndefined()
      expect(scrubChildEnv({ crabot_admin_password: 'case-variant-secret' })).toEqual({})
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('sealed scripts install global tools privately and default MCP inherits only runtime paths', () => {
    const keys = ['CRABOT_PRODUCT_ROOT', 'DATA_DIR', 'UV_CACHE_DIR', 'npm_config_prefix', 'NPM_CONFIG_PREFIX', 'UNRELATED_SECRET', 'PYTHONUTF8', 'PYTHONIOENCODING']
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    Object.assign(process.env, { CRABOT_PRODUCT_ROOT: '/product', DATA_DIR: '/data', UV_CACHE_DIR: '/data/uv', UNRELATED_SECRET: 'must-not-pass', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
    delete process.env.npm_config_prefix
    delete process.env.NPM_CONFIG_PREFIX
    try {
      const env = buildChildEnv()
      expect(env.npm_config_prefix).toBe(path.join('/data', 'agent-tools', 'node'))
      const mcp = buildMcpChildEnv()!
      expect(mcp.UV_CACHE_DIR).toBe('/data/uv')
      expect(mcp.PYTHONUTF8).toBe('1'); expect(mcp.PYTHONIOENCODING).toBe('utf-8')
      expect(mcp.npm_config_prefix).toBe(env.npm_config_prefix)
      expect(mcp.UNRELATED_SECRET).toBeUndefined()
      expect(mcp.CRABOT_TOKEN).toBeUndefined()
      expect(process.env.npm_config_prefix).toBeUndefined()
      expect(buildChildEnv({ npm_config_prefix: '/chosen' }).npm_config_prefix).toBe('/chosen')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
