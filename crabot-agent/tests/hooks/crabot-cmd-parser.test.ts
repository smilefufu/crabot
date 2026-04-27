import { describe, it, expect } from 'vitest'
import { parseCrabotInvocation } from '../../src/hooks/crabot-cmd-parser.js'

describe('parseCrabotInvocation', () => {
  it('裸命令', () => {
    const r = parseCrabotInvocation('crabot provider list')
    expect(r?.subcommand).toBe('provider list')
    expect(r?.hasReveal).toBe(false)
  })
  it('单 token 子命令（如 undo）', () => {
    expect(parseCrabotInvocation('crabot undo')?.subcommand).toBe('undo')
  })
  it('带 cd 前缀', () => {
    expect(parseCrabotInvocation('cd /tmp && crabot provider delete x')?.subcommand).toBe('provider delete')
  })
  it('绝对路径', () => {
    expect(parseCrabotInvocation('/usr/local/bin/crabot agent list')?.subcommand).toBe('agent list')
  })
  it('crabot.mjs 入口', () => {
    expect(parseCrabotInvocation('node ./cli.mjs agent list')).toBeNull()  // node 启动不匹配
    expect(parseCrabotInvocation('./crabot.mjs agent list')?.subcommand).toBe('agent list')
  })
  it('--reveal 检测', () => {
    expect(parseCrabotInvocation('crabot provider show x --reveal')?.hasReveal).toBe(true)
  })
  it('flags 收集', () => {
    const r = parseCrabotInvocation('crabot agent set-model myagent --slot fast --provider openai --model gpt-5')
    expect(r?.subcommand).toBe('agent set-model')
    expect(r?.flags['--slot']).toBe('fast')
    expect(r?.flags['--provider']).toBe('openai')
    expect(r?.flags['--model']).toBe('gpt-5')
  })
  it('未识别为 crabot 命令返回 null', () => {
    expect(parseCrabotInvocation('ls -la')).toBeNull()
  })
})
