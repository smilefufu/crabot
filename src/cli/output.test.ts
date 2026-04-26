import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderResult, renderError } from './output.js'
import { CliError } from './errors.js'

let stdout: string
let stderr: string

beforeEach(() => {
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: any) => { stdout += String(c); return true }) as any)
  vi.spyOn(process.stderr, 'write').mockImplementation(((c: any) => { stderr += String(c); return true }) as any)
})

describe('renderResult', () => {
  it('AI 模式输出 JSON 到 stdout', () => {
    renderResult({ id: 'x', name: 'foo' }, { mode: 'ai' })
    expect(JSON.parse(stdout)).toEqual({ id: 'x', name: 'foo' })
  })

  it('human 模式数组渲染表格', () => {
    renderResult([{ id: 'a3c1f9e2', name: 'foo' }], {
      mode: 'human',
      columns: [
        { key: 'id', header: 'ID' },
        { key: 'name', header: 'NAME' },
      ],
    })
    expect(stdout).toContain('ID')
    expect(stdout).toContain('foo')
  })

  it('human 模式单对象也渲染为单行表格', () => {
    renderResult({ id: 'a3c1f9e2', name: 'foo' }, {
      mode: 'human',
      columns: [{ key: 'id', header: 'ID' }, { key: 'name', header: 'NAME' }],
    })
    expect(stdout).toContain('foo')
  })

  it('human 模式无 columns 时退回 JSON', () => {
    renderResult({ x: 1 }, { mode: 'human' })
    expect(JSON.parse(stdout)).toEqual({ x: 1 })
  })
})

describe('renderError', () => {
  it('AI 模式错误 JSON 到 stderr，stdout 不输出', () => {
    renderError(new CliError('NOT_FOUND', 'oops'), { mode: 'ai' })
    expect(JSON.parse(stderr).error.code).toBe('NOT_FOUND')
    expect(stdout).toBe('')
  })

  it('human 模式输出可读 message 到 stderr', () => {
    renderError(new CliError('NOT_FOUND', 'oops', { ref: 'x' }), { mode: 'human' })
    expect(stderr).toContain('NOT_FOUND')
    expect(stderr).toContain('oops')
  })

  it('human 模式 candidates 列表展开', () => {
    renderError(new CliError('AMBIGUOUS_REFERENCE', 'multi', {
      candidates: [{ id: 'aaaaaaaa-1111', name: 'a' }, { id: 'bbbbbbbb-2222', name: 'b' }],
    }), { mode: 'human' })
    expect(stderr).toContain('Candidates')
    expect(stderr).toContain('aaaaaaaa')
  })
})
