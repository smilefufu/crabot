import { describe, it, expect } from 'vitest'
import { Command } from 'commander'
import { buildSchema } from './schema.js'

describe('buildSchema', () => {
  it('递归遍历 commander 命令树', () => {
    const p = new Command('crabot')
    const provider = p.command('provider')
    provider.command('list').description('list providers')
    provider.command('delete <ref>').description('delete a provider').option('--confirm <token>')
    const schema = buildSchema(p, '1.0.0')
    expect(schema.version).toBe('1.0.0')
    const names = schema.commands.map(c => c.name)
    expect(names).toContain('provider list')
    expect(names).toContain('provider delete')
  })

  it('mustConfirm 命令的 must_confirm=true', () => {
    const p = new Command('crabot')
    const provider = p.command('provider')
    provider.command('delete <ref>').description('delete')
    const schema = buildSchema(p, '1.0.0')
    const del = schema.commands.find(c => c.name === 'provider delete')
    expect(del?.must_confirm).toBe(true)
  })

  it('list / show / doctor 标 read，其他标 write', () => {
    const p = new Command('crabot')
    const agent = p.command('agent')
    agent.command('list')
    agent.command('show <ref>')
    agent.command('restart <ref>')
    agent.command('doctor [ref]')
    const schema = buildSchema(p, '1.0.0')
    expect(schema.commands.find(c => c.name === 'agent list')?.permission).toBe('read')
    expect(schema.commands.find(c => c.name === 'agent show')?.permission).toBe('read')
    expect(schema.commands.find(c => c.name === 'agent doctor')?.permission).toBe('read')
    expect(schema.commands.find(c => c.name === 'agent restart')?.permission).toBe('write')
  })

  it('命令参数被正确提取', () => {
    const p = new Command('crabot')
    const provider = p.command('provider')
    provider.command('delete <ref>').description('delete a provider')
    const schema = buildSchema(p, '1.0.0')
    const del = schema.commands.find(c => c.name === 'provider delete')
    expect(del?.args).toHaveLength(1)
    expect(del?.args[0]?.required).toBe(true)
  })

  it('命令选项被正确提取', () => {
    const p = new Command('crabot')
    const provider = p.command('provider')
    provider.command('add').description('add provider').option('--name <n>', 'Provider name').option('--apikey <k>', 'API key')
    const schema = buildSchema(p, '1.0.0')
    const add = schema.commands.find(c => c.name === 'provider add')
    expect(add?.options.some(o => o.flags.includes('--name'))).toBe(true)
    expect(add?.options.some(o => o.flags.includes('--apikey'))).toBe(true)
  })

  it('程序根节点自身不出现在命令列表', () => {
    const p = new Command('crabot')
    p.command('provider').command('list')
    const schema = buildSchema(p, '1.0.0')
    expect(schema.commands.every(c => c.name !== '')).toBe(true)
    expect(schema.commands.every(c => c.name !== 'crabot')).toBe(true)
  })

  it('option.required 反映 flag 本身是否必填（不是值是否必填）', () => {
    // commander Option：mandatory = flag 必填（requiredOption），required = flag 给定时值必填（<value>）
    // schema 给 LLM 看的 required 应是前者，否则 LLM 会以为所有 <value> 选项都必填
    const p = new Command('crabot')
    const provider = p.command('provider')
    provider
      .command('add')
      .requiredOption('--name <n>', 'Provider name')   // mandatory=true, required=true
      .option('--apikey <k>', 'API key')                // mandatory=false, required=true（值带 <>）
      .option('--dry-run', 'Just preview')              // mandatory=false, required=false
    const schema = buildSchema(p, '1.0.0')
    const add = schema.commands.find(c => c.name === 'provider add')!
    const byFlag = (f: string) => add.options.find(o => o.flags.startsWith(f))!
    expect(byFlag('--name').required).toBe(true)        // requiredOption → required=true
    expect(byFlag('--apikey').required).toBe(false)     // option <value> → required=false（核心断言）
    expect(byFlag('--dry-run').required).toBe(false)
  })
})
