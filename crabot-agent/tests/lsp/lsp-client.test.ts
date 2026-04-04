import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LspClient, type LspClientConfig, type LspClientState } from '../../src/lsp/lsp-client'

// Mock child_process.spawn
vi.mock('child_process', () => {
  const { EventEmitter } = require('events')
  const { PassThrough } = require('stream')

  function createMockProcess(): any {
    const proc = new EventEmitter()
    proc.stdin = new PassThrough()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.pid = 12345
    proc.kill = vi.fn()
    proc.removeAllListeners = vi.fn().mockReturnThis()

    // Also mock removeAllListeners on streams
    proc.stdin.removeAllListeners = vi.fn().mockReturnThis()
    proc.stderr.removeAllListeners = vi.fn().mockReturnThis()

    // Auto-emit 'spawn' on next tick to simulate successful spawn
    setTimeout(() => proc.emit('spawn'), 0)

    return proc
  }

  return {
    spawn: vi.fn(() => createMockProcess()),
  }
})

// Mock vscode-jsonrpc/node
vi.mock('vscode-jsonrpc/node', () => {
  const { EventEmitter } = require('events')

  function createMockConnection(): any {
    const conn = {
      listen: vi.fn(),
      sendRequest: vi.fn().mockResolvedValue({ capabilities: {} }),
      sendNotification: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      dispose: vi.fn(),
    }
    return conn
  }

  return {
    createMessageConnection: vi.fn(() => createMockConnection()),
    StreamMessageReader: vi.fn(),
    StreamMessageWriter: vi.fn(),
  }
})

function createConfig(overrides?: Partial<LspClientConfig>): LspClientConfig {
  return {
    command: 'typescript-language-server',
    args: ['--stdio'],
    cwd: '/tmp/test-project',
    startupTimeout: 5000,
    maxRestarts: 3,
    ...overrides,
  }
}

describe('LspClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('sets initial state to stopped', () => {
      const client = new LspClient(createConfig())
      expect(client.getState()).toBe('stopped' satisfies LspClientState)
    })
  })

  describe('getState', () => {
    it('returns the current state', () => {
      const client = new LspClient(createConfig())
      expect(client.getState()).toBe('stopped')
    })
  })

  describe('start', () => {
    it('transitions state to running on success', async () => {
      const client = new LspClient(createConfig())
      await client.start()
      expect(client.getState()).toBe('running')
    })

    it('is idempotent when already running', async () => {
      const client = new LspClient(createConfig())
      await client.start()
      // Second start should be a no-op
      await client.start()
      expect(client.getState()).toBe('running')
    })

    it('sets state to error on spawn failure', async () => {
      const { spawn } = await import('child_process')
      const { EventEmitter } = require('events')
      const { PassThrough } = require('stream')

      // Override spawn to emit 'error' instead of 'spawn'
      ;(spawn as any).mockImplementationOnce(() => {
        const proc = new EventEmitter()
        proc.stdin = new PassThrough()
        proc.stdout = new PassThrough()
        proc.stderr = new PassThrough()
        proc.pid = 12345
        proc.kill = vi.fn()
        proc.removeAllListeners = vi.fn().mockReturnThis()
        proc.stdin.removeAllListeners = vi.fn().mockReturnThis()
        proc.stderr.removeAllListeners = vi.fn().mockReturnThis()

        setTimeout(() => proc.emit('error', new Error('ENOENT')), 0)
        return proc
      })

      const client = new LspClient(createConfig())
      await expect(client.start()).rejects.toThrow('ENOENT')
      expect(client.getState()).toBe('error')
    })
  })

  describe('stop', () => {
    it('transitions state to stopped', async () => {
      const client = new LspClient(createConfig())
      await client.start()
      expect(client.getState()).toBe('running')

      await client.stop()
      expect(client.getState()).toBe('stopped')
    })

    it('is a no-op when already stopped', async () => {
      const client = new LspClient(createConfig())
      // Should not throw
      await client.stop()
      expect(client.getState()).toBe('stopped')
    })
  })

  describe('sendRequest', () => {
    it('throws when client is not running', async () => {
      const client = new LspClient(createConfig())
      await expect(
        client.sendRequest('textDocument/hover', {}),
      ).rejects.toThrow('Cannot send request: LSP client is stopped')
    })

    it('forwards request to the connection when running', async () => {
      const { createMessageConnection } = await import('vscode-jsonrpc/node')
      const client = new LspClient(createConfig())
      await client.start()

      // The mock connection is created by createMessageConnection
      const mockConn = (createMessageConnection as any).mock.results[0].value
      mockConn.sendRequest.mockResolvedValueOnce({ contents: 'hover info' })

      const result = await client.sendRequest('textDocument/hover', { position: { line: 0, character: 0 } })
      expect(result).toEqual({ contents: 'hover info' })
    })
  })

  describe('sendNotification', () => {
    it('throws when client is not running', () => {
      const client = new LspClient(createConfig())
      expect(() =>
        client.sendNotification('textDocument/didOpen', {}),
      ).toThrow('Cannot send notification: LSP client is stopped')
    })

    it('forwards notification to the connection when running', async () => {
      const { createMessageConnection } = await import('vscode-jsonrpc/node')
      const client = new LspClient(createConfig())
      await client.start()

      const mockConn = (createMessageConnection as any).mock.results[0].value

      client.sendNotification('textDocument/didOpen', { textDocument: { uri: 'file:///test.ts' } })
      expect(mockConn.sendNotification).toHaveBeenCalledWith(
        'textDocument/didOpen',
        { textDocument: { uri: 'file:///test.ts' } },
      )
    })
  })

  describe('sendRequest retry on content modified', () => {
    it('retries on content modified error (-32801) with backoff', async () => {
      const { createMessageConnection } = await import('vscode-jsonrpc/node')
      const client = new LspClient(createConfig())
      await client.start()

      const mockConn = (createMessageConnection as any).mock.results[0].value
      const contentModifiedError = Object.assign(new Error('Content Modified'), { code: -32801 })

      // Fail twice with content modified, then succeed
      mockConn.sendRequest
        .mockRejectedValueOnce(contentModifiedError)
        .mockRejectedValueOnce(contentModifiedError)
        .mockResolvedValueOnce({ result: 'ok' })

      const result = await client.sendRequest('textDocument/definition', {})
      expect(result).toEqual({ result: 'ok' })
      // initialize (1) + 3 attempts for our request
      expect(mockConn.sendRequest).toHaveBeenCalledTimes(4)
    })

    it('throws after max retries on persistent content modified error', async () => {
      const { createMessageConnection } = await import('vscode-jsonrpc/node')
      const client = new LspClient(createConfig())
      await client.start()

      const mockConn = (createMessageConnection as any).mock.results[0].value
      const contentModifiedError = Object.assign(new Error('Content Modified'), { code: -32801 })

      mockConn.sendRequest.mockRejectedValue(contentModifiedError)

      await expect(
        client.sendRequest('textDocument/definition', {}),
      ).rejects.toThrow('Content Modified')
    })

    it('does not retry on non-transient errors', async () => {
      const { createMessageConnection } = await import('vscode-jsonrpc/node')
      const client = new LspClient(createConfig())
      await client.start()

      const mockConn = (createMessageConnection as any).mock.results[0].value
      const otherError = Object.assign(new Error('Server error'), { code: -32600 })

      // Reset call count after initialize
      const initCallCount = mockConn.sendRequest.mock.calls.length

      mockConn.sendRequest.mockRejectedValueOnce(otherError)

      await expect(
        client.sendRequest('textDocument/definition', {}),
      ).rejects.toThrow('Server error')

      // Should only have been called once for our request (no retries)
      expect(mockConn.sendRequest.mock.calls.length - initCallCount).toBe(1)
    })
  })
})
