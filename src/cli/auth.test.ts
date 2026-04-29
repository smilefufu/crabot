import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAuth } from './auth.js'

interface EnvSnapshot {
  readonly CRABOT_TOKEN: string | undefined
  readonly CRABOT_ENDPOINT: string | undefined
  readonly CRABOT_HOME: string | undefined
  readonly CRABOT_PORT_OFFSET: string | undefined
  readonly DATA_DIR: string | undefined
}

function snapshotEnv(): EnvSnapshot {
  return {
    CRABOT_TOKEN: process.env['CRABOT_TOKEN'],
    CRABOT_ENDPOINT: process.env['CRABOT_ENDPOINT'],
    CRABOT_HOME: process.env['CRABOT_HOME'],
    CRABOT_PORT_OFFSET: process.env['CRABOT_PORT_OFFSET'],
    DATA_DIR: process.env['DATA_DIR'],
  }
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of Object.keys(snap) as Array<keyof EnvSnapshot>) {
    const value = snap[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

describe('resolveAuth', () => {
  let envSnap: EnvSnapshot
  let tmpCwd: string
  const homes: string[] = []

  function makeFakeHome(tokenContent = 'token-from-home\n'): string {
    const home = mkdtempSync(join(tmpdir(), 'crabot-home-'))
    mkdirSync(join(home, 'data', 'admin'), { recursive: true })
    writeFileSync(join(home, 'data', 'admin', 'internal-token'), tokenContent)
    homes.push(home)
    return home
  }

  beforeEach(() => {
    envSnap = snapshotEnv()
    delete process.env['CRABOT_TOKEN']
    delete process.env['CRABOT_ENDPOINT']
    delete process.env['CRABOT_HOME']
    delete process.env['CRABOT_PORT_OFFSET']
    delete process.env['DATA_DIR']
    tmpCwd = mkdtempSync(join(tmpdir(), 'crabot-cwd-'))
    vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(tmpCwd, { recursive: true, force: true })
    while (homes.length > 0) {
      const h = homes.pop()
      if (h) rmSync(h, { recursive: true, force: true })
    }
    restoreEnv(envSnap)
  })

  it('CRABOT_HOME env 优先于 cwd 解析 token', () => {
    process.env['CRABOT_HOME'] = makeFakeHome()
    expect(resolveAuth({}).token).toBe('token-from-home')
  })

  it('显式 crabotHome 选项优先于 CRABOT_HOME env', () => {
    process.env['CRABOT_HOME'] = makeFakeHome()
    const otherHome = makeFakeHome('token-from-opt\n')
    expect(resolveAuth({ crabotHome: otherHome }).token).toBe('token-from-opt')
  })

  it('cwd 没有 token 且未设置 CRABOT_HOME 时报错', () => {
    expect(() => resolveAuth({})).toThrow(/Cannot resolve auth token/)
  })

  it('CRABOT_TOKEN env 优先级最高（早于文件查找）', () => {
    process.env['CRABOT_TOKEN'] = 'env-token'
    process.env['CRABOT_HOME'] = '/non/existent/path'
    expect(resolveAuth({}).token).toBe('env-token')
  })

  it('DATA_DIR 为绝对路径（MM 注入 agent 子目录）时正确解析 token', () => {
    // 模拟 MM 给 agent 进程注入的场景：
    //   DATA_DIR = /path/to/crabot/data/agent  (绝对路径，指向模块子目录)
    //   CRABOT_HOME = /path/to/crabot           (cli.mjs 注入)
    // token 实际位于 /path/to/crabot/data/admin/internal-token
    const home = makeFakeHome('agent-context-token\n')
    process.env['CRABOT_HOME'] = home
    // 模拟 MM 注入的 agent-specific DATA_DIR（绝对路径）
    process.env['DATA_DIR'] = join(home, 'data', 'agent')
    expect(resolveAuth({}).token).toBe('agent-context-token')
  })

  it('DATA_DIR 绝对路径不应与 CRABOT_HOME 拼接产生双份路径', () => {
    const home = makeFakeHome()
    process.env['CRABOT_HOME'] = home
    process.env['DATA_DIR'] = join(home, 'data', 'agent')
    // 如果路径被拼接两次，readFileSync 会抛 ENOENT（路径不存在）
    // 正确行为：应该能读到 token，而不是报路径错误
    expect(() => resolveAuth({})).not.toThrow()
  })
})
