import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSecretRefs, _clearSecretFileCache } from './secret-resolver.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-secret-'))
  _clearSecretFileCache()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  _clearSecretFileCache()
})

describe('resolveSecretRefs', () => {
  it('原样透传纯字符串配置（老 openclaw.json 行为不变）', () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_xxx',
          appSecret: 'plain-secret',
          domain: 'feishu',
        },
      },
    }
    const out = resolveSecretRefs(cfg) as typeof cfg
    expect(out).toEqual(cfg)
    // 不可变：返回新对象
    expect(out).not.toBe(cfg)
    expect(out.channels.feishu.appSecret).toBe('plain-secret')
  })

  it('source=file 的 SecretRef 从 provider 文件解析为明文', () => {
    const credPath = path.join(tmpDir, 'lark.secrets.json')
    fs.writeFileSync(credPath, JSON.stringify({ lark: { appSecret: 'real-secret-value' } }))
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_a97b78770ebadbdb',
          appSecret: { source: 'file', provider: 'lark-secrets', id: '/lark/appSecret' },
          domain: 'feishu',
        },
      },
      secrets: {
        providers: {
          'lark-secrets': { source: 'file', path: credPath },
        },
      },
    }
    const out = resolveSecretRefs(cfg) as { channels: { feishu: { appSecret: unknown } } }
    expect(out.channels.feishu.appSecret).toBe('real-secret-value')
  })

  it('source=env 从环境变量解析', () => {
    process.env.CRABOT_TEST_SECRET = 'env-secret-value'
    try {
      const cfg = {
        channels: {
          feishu: {
            appSecret: { source: 'env', id: 'CRABOT_TEST_SECRET' },
          },
        },
      }
      const out = resolveSecretRefs(cfg) as { channels: { feishu: { appSecret: unknown } } }
      expect(out.channels.feishu.appSecret).toBe('env-secret-value')
    } finally {
      delete process.env.CRABOT_TEST_SECRET
    }
  })

  it('source=value 取字面值', () => {
    const cfg = {
      channels: { feishu: { appSecret: { source: 'value', value: 'inline' } } },
    }
    const out = resolveSecretRefs(cfg) as { channels: { feishu: { appSecret: unknown } } }
    expect(out.channels.feishu.appSecret).toBe('inline')
  })

  it('provider 文件不存在抛错（不静默回退）', () => {
    const cfg = {
      channels: {
        feishu: {
          appSecret: { source: 'file', provider: 'lark-secrets', id: '/lark/appSecret' },
        },
      },
      secrets: {
        providers: {
          'lark-secrets': { source: 'file', path: path.join(tmpDir, 'does-not-exist.json') },
        },
      },
    }
    expect(() => resolveSecretRefs(cfg)).toThrow()
  })

  it('找不到 provider 抛错', () => {
    const cfg = {
      channels: {
        feishu: {
          appSecret: { source: 'file', provider: 'unknown-provider', id: '/x' },
        },
      },
    }
    expect(() => resolveSecretRefs(cfg)).toThrow(/unknown-provider/)
  })

  it('文件里 id 路径找不到值抛错', () => {
    const credPath = path.join(tmpDir, 'partial.json')
    fs.writeFileSync(credPath, JSON.stringify({ lark: {} }))
    const cfg = {
      channels: {
        feishu: {
          appSecret: { source: 'file', provider: 'p', id: '/lark/appSecret' },
        },
      },
      secrets: { providers: { p: { source: 'file', path: credPath } } },
    }
    expect(() => resolveSecretRefs(cfg)).toThrow(/未找到字符串值/)
  })

  it('source=env 但变量未设置抛错', () => {
    delete process.env.CRABOT_TEST_MISSING
    const cfg = {
      channels: { feishu: { appSecret: { source: 'env', id: 'CRABOT_TEST_MISSING' } } },
    }
    expect(() => resolveSecretRefs(cfg)).toThrow(/CRABOT_TEST_MISSING/)
  })

  it('~ 开头的 provider 路径会展开为家目录', () => {
    const home = os.homedir()
    // 用真实 home 下不可能存在的路径，触发文件不存在错误，确认路径展开后是绝对路径
    const cfg = {
      secrets: { providers: { p: { source: 'file', path: '~/.crabot-test-nonexistent-xyz123.json' } } },
      channels: { feishu: { appSecret: { source: 'file', provider: 'p', id: '/x' } } },
    }
    try {
      resolveSecretRefs(cfg)
      // 不应到达这里
      expect.fail('expected throw')
    } catch (e) {
      // 错误信息中应包含展开后的路径
      const msg = (e as Error).message
      expect(msg).toContain(home)
    }
  })

  it('secrets.providers 段自身不会被误识别为 SecretRef', () => {
    // provider 定义有 source='file' 但没有 id/value 字段，应该被跳过
    const credPath = path.join(tmpDir, 's.json')
    fs.writeFileSync(credPath, JSON.stringify({ k: 'v' }))
    const cfg = {
      secrets: { providers: { p: { source: 'file', path: credPath } } },
      channels: { feishu: { appSecret: 'plain' } },
    }
    const out = resolveSecretRefs(cfg) as typeof cfg
    expect(out.secrets.providers.p).toEqual({ source: 'file', path: credPath })
    expect(out.channels.feishu.appSecret).toBe('plain')
  })

  it('深嵌套与数组里的 SecretRef 都会被解析', () => {
    const credPath = path.join(tmpDir, 'multi.json')
    fs.writeFileSync(credPath, JSON.stringify({ a: { b: 'A' }, c: 'C' }))
    const cfg = {
      secrets: { providers: { p: { source: 'file', path: credPath } } },
      channels: {
        feishu: {
          accounts: {
            bot1: { appSecret: { source: 'file', provider: 'p', id: '/a/b' } },
          },
          tags: ['static', { source: 'file', provider: 'p', id: '/c' }],
        },
      },
    }
    const out = resolveSecretRefs(cfg) as {
      channels: { feishu: { accounts: { bot1: { appSecret: unknown } }; tags: unknown[] } }
    }
    expect(out.channels.feishu.accounts.bot1.appSecret).toBe('A')
    expect(out.channels.feishu.tags).toEqual(['static', 'C'])
  })

  it('non-object 配置原样返回（防御性）', () => {
    expect(resolveSecretRefs(null)).toBeNull()
    expect(resolveSecretRefs(undefined)).toBeUndefined()
    expect(resolveSecretRefs('string-config')).toBe('string-config')
  })
})
