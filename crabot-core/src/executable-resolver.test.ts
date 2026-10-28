import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveExecutable } from './executable-resolver.js'

const originalRoot = process.env.CRABOT_PRODUCT_ROOT
const directories: string[] = []
afterEach(() => {
  if (originalRoot === undefined) delete process.env.CRABOT_PRODUCT_ROOT
  else process.env.CRABOT_PRODUCT_ROOT = originalRoot
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('required product executable resolution', () => {
  it('does not borrow host Node or Python when required product resources are missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-required-tools-'))
    directories.push(root)
    process.env.CRABOT_PRODUCT_ROOT = root
    for (const command of ['node', 'python3', 'uv']) {
      expect(() => resolveExecutable(command)).toThrow(/runtime/)
    }
  })

  it('retains explicit executable paths and ordinary source command resolution', () => {
    delete process.env.CRABOT_PRODUCT_ROOT
    expect(resolveExecutable(process.execPath)).toBe(process.execPath)
    expect(resolveExecutable('crabot-fixture-no-host-command')).toBe('crabot-fixture-no-host-command')
  })
})
