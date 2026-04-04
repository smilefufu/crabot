import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  LspServerManager,
  getDefaultServerConfigs,
  type LspServerConfig,
} from '../../src/lsp/lsp-server-manager'

// Mock LspClient
vi.mock('../../src/lsp/lsp-client', () => {
  return {
    LspClient: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue(undefined),
      sendNotification: vi.fn(),
      getState: vi.fn().mockReturnValue('running'),
    })),
  }
})

// Mock fs/promises for sendRequest auto-open
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('file content from disk'),
}))

function createTsConfig(): LspServerConfig {
  return {
    name: 'typescript-language-server',
    command: 'npx',
    args: ['typescript-language-server', '--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    languageIds: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
    },
  }
}

function createPythonConfig(): LspServerConfig {
  return {
    name: 'pylsp',
    command: 'pylsp',
    args: [],
    extensions: ['.py'],
    languageIds: {
      '.py': 'python',
    },
  }
}

describe('LspServerManager', () => {
  let manager: LspServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new LspServerManager('/tmp/test-project')
  })

  describe('registerServer', () => {
    it('builds correct extension mapping', () => {
      const config = createTsConfig()
      manager.registerServer(config)

      // Verify by requesting a server for a .ts file - should not return null
      // (actual verification happens via getServerForFile tests)
      expect(() => manager.registerServer(config)).not.toThrow()
    })
  })

  describe('getServerForFile', () => {
    it('returns null for unknown extensions', async () => {
      manager.registerServer(createTsConfig())
      const server = await manager.getServerForFile('/tmp/test.rb')
      expect(server).toBeNull()
    })

    it('creates and starts client for known extension', async () => {
      const { LspClient } = await import('../../src/lsp/lsp-client')
      manager.registerServer(createTsConfig())

      const server = await manager.getServerForFile('/tmp/test.ts')
      expect(server).not.toBeNull()
      expect(LspClient).toHaveBeenCalledWith({
        command: 'npx',
        args: ['typescript-language-server', '--stdio'],
        cwd: '/tmp/test-project',
      })
      expect(server!.start).toHaveBeenCalled()
    })

    it('returns same client for same server (no duplicate start)', async () => {
      manager.registerServer(createTsConfig())

      const server1 = await manager.getServerForFile('/tmp/test.ts')
      const server2 = await manager.getServerForFile('/tmp/other.tsx')

      expect(server1).toBe(server2)
      // start() should only be called once
      expect(server1!.start).toHaveBeenCalledTimes(1)
    })

    it('returns different clients for different servers', async () => {
      manager.registerServer(createTsConfig())
      manager.registerServer(createPythonConfig())

      const tsServer = await manager.getServerForFile('/tmp/test.ts')
      const pyServer = await manager.getServerForFile('/tmp/test.py')

      expect(tsServer).not.toBe(pyServer)
    })
  })

  describe('openFile', () => {
    it('sends didOpen notification', async () => {
      manager.registerServer(createTsConfig())

      await manager.openFile('/tmp/test.ts', 'const x = 1')

      const server = await manager.getServerForFile('/tmp/test.ts')
      expect(server!.sendNotification).toHaveBeenCalledWith(
        'textDocument/didOpen',
        {
          textDocument: {
            uri: 'file:///tmp/test.ts',
            languageId: 'typescript',
            version: 1,
            text: 'const x = 1',
          },
        },
      )
    })

    it('skips if file already open', async () => {
      manager.registerServer(createTsConfig())

      await manager.openFile('/tmp/test.ts', 'const x = 1')
      await manager.openFile('/tmp/test.ts', 'const x = 2')

      const server = await manager.getServerForFile('/tmp/test.ts')
      // sendNotification: 1 didOpen only (second call is skipped)
      const didOpenCalls = (server!.sendNotification as ReturnType<typeof vi.fn>).mock.calls
        .filter(([method]: [string]) => method === 'textDocument/didOpen')
      expect(didOpenCalls).toHaveLength(1)
    })

    it('does nothing for unknown extensions', async () => {
      manager.registerServer(createTsConfig())
      // Should not throw
      await manager.openFile('/tmp/test.rb', 'puts "hello"')
    })
  })

  describe('changeFile', () => {
    it('sends didChange notification', async () => {
      manager.registerServer(createTsConfig())

      // Must open first
      await manager.openFile('/tmp/test.ts', 'const x = 1')
      await manager.changeFile('/tmp/test.ts', 'const x = 2')

      const server = await manager.getServerForFile('/tmp/test.ts')
      expect(server!.sendNotification).toHaveBeenCalledWith(
        'textDocument/didChange',
        {
          textDocument: {
            uri: 'file:///tmp/test.ts',
            version: 2,
          },
          contentChanges: [{ text: 'const x = 2' }],
        },
      )
    })
  })

  describe('saveFile', () => {
    it('sends didSave notification', async () => {
      manager.registerServer(createTsConfig())
      await manager.openFile('/tmp/test.ts', 'const x = 1')
      await manager.saveFile('/tmp/test.ts')

      const server = await manager.getServerForFile('/tmp/test.ts')
      expect(server!.sendNotification).toHaveBeenCalledWith(
        'textDocument/didSave',
        {
          textDocument: {
            uri: 'file:///tmp/test.ts',
          },
        },
      )
    })
  })

  describe('closeFile', () => {
    it('sends didClose notification and removes tracking', async () => {
      manager.registerServer(createTsConfig())
      await manager.openFile('/tmp/test.ts', 'const x = 1')
      await manager.closeFile('/tmp/test.ts')

      const server = await manager.getServerForFile('/tmp/test.ts')
      expect(server!.sendNotification).toHaveBeenCalledWith(
        'textDocument/didClose',
        {
          textDocument: {
            uri: 'file:///tmp/test.ts',
          },
        },
      )

      // After close, opening again should send didOpen again
      await manager.openFile('/tmp/test.ts', 'const x = 3')
      const didOpenCalls = (server!.sendNotification as ReturnType<typeof vi.fn>).mock.calls
        .filter(([method]: [string]) => method === 'textDocument/didOpen')
      expect(didOpenCalls).toHaveLength(2)
    })
  })

  describe('sendRequest', () => {
    it('auto-opens file if not yet open', async () => {
      manager.registerServer(createTsConfig())

      await manager.sendRequest('/tmp/test.ts', 'textDocument/hover', {
        textDocument: { uri: 'file:///tmp/test.ts' },
        position: { line: 0, character: 0 },
      })

      const server = await manager.getServerForFile('/tmp/test.ts')
      // Should have auto-opened with content read from disk
      const didOpenCalls = (server!.sendNotification as ReturnType<typeof vi.fn>).mock.calls
        .filter(([method]: [string]) => method === 'textDocument/didOpen')
      expect(didOpenCalls).toHaveLength(1)
      expect(didOpenCalls[0][1].textDocument.text).toBe('file content from disk')

      // Should have forwarded the request
      expect(server!.sendRequest).toHaveBeenCalledWith(
        'textDocument/hover',
        {
          textDocument: { uri: 'file:///tmp/test.ts' },
          position: { line: 0, character: 0 },
        },
      )
    })

    it('skips auto-open if file already open', async () => {
      manager.registerServer(createTsConfig())
      await manager.openFile('/tmp/test.ts', 'const x = 1')

      await manager.sendRequest('/tmp/test.ts', 'textDocument/hover', {})

      const server = await manager.getServerForFile('/tmp/test.ts')
      const didOpenCalls = (server!.sendNotification as ReturnType<typeof vi.fn>).mock.calls
        .filter(([method]: [string]) => method === 'textDocument/didOpen')
      expect(didOpenCalls).toHaveLength(1) // Only the explicit openFile call
    })

    it('returns null for unknown extensions', async () => {
      manager.registerServer(createTsConfig())
      const result = await manager.sendRequest('/tmp/test.rb', 'textDocument/hover', {})
      expect(result).toBeNull()
    })
  })

  describe('stopAll', () => {
    it('stops all running servers', async () => {
      manager.registerServer(createTsConfig())
      manager.registerServer(createPythonConfig())

      const tsServer = await manager.getServerForFile('/tmp/test.ts')
      const pyServer = await manager.getServerForFile('/tmp/test.py')

      await manager.stopAll()

      expect(tsServer!.stop).toHaveBeenCalled()
      expect(pyServer!.stop).toHaveBeenCalled()
    })

    it('clears all internal state', async () => {
      manager.registerServer(createTsConfig())
      await manager.openFile('/tmp/test.ts', 'const x = 1')
      await manager.getServerForFile('/tmp/test.ts')

      await manager.stopAll()

      // After stopAll, getServerForFile should return null (servers map cleared)
      const server = await manager.getServerForFile('/tmp/test.ts')
      expect(server).toBeNull()
    })
  })

  describe('getDefaultServerConfigs', () => {
    it('returns TypeScript config', () => {
      const configs = getDefaultServerConfigs()
      expect(configs).toHaveLength(1)
      expect(configs[0].name).toBe('typescript-language-server')
      expect(configs[0].extensions).toContain('.ts')
      expect(configs[0].extensions).toContain('.tsx')
      expect(configs[0].extensions).toContain('.js')
      expect(configs[0].extensions).toContain('.jsx')
      expect(configs[0].extensions).toContain('.mjs')
      expect(configs[0].extensions).toContain('.cjs')
      expect(configs[0].languageIds['.ts']).toBe('typescript')
      expect(configs[0].languageIds['.tsx']).toBe('typescriptreact')
    })
  })
})
