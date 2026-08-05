import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { terminateProcessTree, waitForProcessTreeExit } from './process-tree.js'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', { value: 'win32' })

function ownership(rootPid: number | null, listenerPids: number[] = []): string {
  return JSON.stringify({ RootPid: rootPid, ListenerPids: listenerPids })
}

function mockCommands(powershellOutputs: Array<string | Error>): void {
  execFileMock.mockImplementation(
    (file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      if (file === 'powershell.exe') {
        const result = powershellOutputs.shift() ?? ownership(null)
        if (result instanceof Error) callback(result, '')
        else callback(null, result)
        return
      }
      callback(null, '')
    },
  )
}

beforeEach(() => {
  execFileMock.mockReset()
})

afterAll(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

describe('Windows process ownership fallback', () => {
  it('targets only the live root even when a listener PID is also visible', async () => {
    mockCommands([
      ownership(100, [200]),
      ownership(100, [200]),
      ownership(null),
    ])

    await terminateProcessTree(100, {
      gracefulTimeoutMs: 10,
      forceImmediately: true,
      modulePort: 19042,
    })

    const taskkills = execFileMock.mock.calls.filter(([file]) => file === 'taskkill')
    expect(taskkills.map(call => call[1])).toEqual([
      ['/PID', '100', '/T', '/F'],
    ])
  })

  it('switches from the vanished root to one listener only during escalation', async () => {
    mockCommands([
      ownership(100, [200]),
      ownership(null, [200]),
      ownership(null, [200]),
      ownership(null),
    ])

    await terminateProcessTree(100, {
      gracefulTimeoutMs: 0,
      modulePort: 19042,
    })

    const taskkills = execFileMock.mock.calls.filter(([file]) => file === 'taskkill')
    expect(taskkills.map(call => call[1])).toEqual([
      ['/PID', '100', '/T'],
      ['/PID', '200', '/T', '/F'],
    ])
  })

  it('fails closed if ownership becomes ambiguous after the root disappears', async () => {
    mockCommands([
      ownership(100),
      ownership(null, [200, 201]),
    ])

    await expect(terminateProcessTree(100, {
      gracefulTimeoutMs: 0,
      modulePort: 19042,
    })).rejects.toThrow('Ambiguous Windows module listener ownership')

    const taskkills = execFileMock.mock.calls.filter(([file]) => file === 'taskkill')
    expect(taskkills.map(call => call[1])).toEqual([
      ['/PID', '100', '/T'],
    ])
  })

  it('uses the unique module listener PID only after the launcher is gone', async () => {
    mockCommands([
      ownership(null, [200]),
      ownership(null, [200]),
      ownership(null),
    ])

    await terminateProcessTree(100, {
      gracefulTimeoutMs: 10,
      forceImmediately: true,
      modulePort: 19042,
      requireOwnedProcess: true,
    })

    const powershell = execFileMock.mock.calls.find(([file]) => file === 'powershell.exe')
    expect(powershell?.[1].join(' ')).toContain('LocalPort 19042')
    const taskkills = execFileMock.mock.calls.filter(([file]) => file === 'taskkill')
    expect(taskkills.map(call => call[1])).toEqual([
      ['/PID', '200', '/T', '/F'],
    ])
  })

  it('fails closed after an unexpected exit when neither root nor listener is identifiable', async () => {
    mockCommands([ownership(null)])

    await expect(terminateProcessTree(100, {
      gracefulTimeoutMs: 10,
      modulePort: 19042,
      requireOwnedProcess: true,
    })).rejects.toThrow('Cannot confirm Windows process ownership')
    expect(execFileMock.mock.calls.some(([file]) => file === 'taskkill')).toBe(false)
  })

  it('fails closed when launcher is gone and listener ownership is ambiguous', async () => {
    mockCommands([ownership(null, [200, 201])])

    await expect(terminateProcessTree(100, {
      gracefulTimeoutMs: 10,
      modulePort: 19042,
      requireOwnedProcess: true,
    })).rejects.toThrow('Ambiguous Windows module listener ownership')
    expect(execFileMock.mock.calls.some(([file]) => file === 'taskkill')).toBe(false)
  })

  it('ignores ambiguous listeners while the exact root is still alive', async () => {
    mockCommands([
      ownership(100, [200, 201]),
      ownership(100, [200, 201]),
      ownership(null),
    ])

    await terminateProcessTree(100, {
      gracefulTimeoutMs: 10,
      forceImmediately: true,
      modulePort: 19042,
    })

    const taskkills = execFileMock.mock.calls.filter(([file]) => file === 'taskkill')
    expect(taskkills.map(call => call[1])).toEqual([
      ['/PID', '100', '/T', '/F'],
    ])
  })

  it('allows a planned shutdown to confirm that root and listener are both gone', async () => {
    mockCommands([ownership(null)])

    await expect(waitForProcessTreeExit(100, 10, 1, 19042)).resolves.toBe(true)
  })

  it('fails closed when the ownership query itself is unavailable', async () => {
    mockCommands([new Error('PowerShell unavailable')])

    await expect(terminateProcessTree(100, {
      gracefulTimeoutMs: 10,
      modulePort: 19042,
      requireOwnedProcess: true,
    })).rejects.toThrow('PowerShell unavailable')
  })
})
