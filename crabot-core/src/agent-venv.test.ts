import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureAgentVenv } from './agent-venv.js'

const IS_WIN = process.platform === 'win32'
const BIN_DIR = IS_WIN ? 'Scripts' : 'bin'
const PY = IS_WIN ? 'python.exe' : 'python'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-venv-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createFakeVenvPython(dataDir: string) {
  const binDir = path.join(dataDir, 'agent-venv', BIN_DIR)
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, PY), '')
}

describe('ensureAgentVenv', () => {
  it('venv python 已存在时不调用 uv，PATH 以 venv bin 开头且保留原 PATH', () => {
    createFakeVenvPython(tmpDir)
    const spawn = vi.fn()

    const result = ensureAgentVenv(tmpDir, spawn as never)

    expect(spawn).not.toHaveBeenCalled()
    const venvBin = path.join(tmpDir, 'agent-venv', BIN_DIR)
    expect(result).toBe(venvBin + path.delimiter + (process.env.PATH ?? ''))
  })

  it('venv 缺失时调用 uv venv --seed 重建，成功后 PATH 前置', () => {
    const spawn = vi.fn((...args: unknown[]) => {
      // 模拟 uv venv：创建 venv python
      createFakeVenvPython(tmpDir)
      return { error: undefined, status: 0, stderr: '' }
    })

    const result = ensureAgentVenv(tmpDir, spawn as never)

    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args] = spawn.mock.calls[0] as [string, string[]]
    expect(args).toEqual(['venv', '--seed', path.join(tmpDir, 'agent-venv')])
    expect(path.basename(cmd)).toMatch(/^uv(\.exe)?$/)
    const venvBin = path.join(tmpDir, 'agent-venv', BIN_DIR)
    expect(result).toBe(venvBin + path.delimiter + (process.env.PATH ?? ''))
  })

  it('uv 不可用（spawn error）时返回 null，不抛异常', () => {
    const spawn = vi.fn(() => ({ error: new Error('spawn uv ENOENT'), status: null, stderr: '' }))

    const result = ensureAgentVenv(tmpDir, spawn as never)

    expect(result).toBeNull()
  })

  it('uv venv 非零退出时返回 null，不抛异常', () => {
    const spawn = vi.fn(() => ({ error: undefined, status: 1, stderr: 'network unreachable' }))

    const result = ensureAgentVenv(tmpDir, spawn as never)

    expect(result).toBeNull()
  })

  it('uv venv 成功但 python 仍缺失（损坏）时返回 null', () => {
    const spawn = vi.fn(() => ({ error: undefined, status: 0, stderr: '' }))

    const result = ensureAgentVenv(tmpDir, spawn as never)

    expect(result).toBeNull()
  })
})
