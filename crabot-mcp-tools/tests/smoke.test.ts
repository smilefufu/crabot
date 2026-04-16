import { describe, it, expect } from 'vitest'
import { createComputerUseServer } from '../src/computer-use/server'
import { createGitServer } from '../src/git/server'

describe('MCP Tools Package', () => {
  it('createComputerUseServer returns McpServer', () => {
    const server = createComputerUseServer()
    expect(server).toBeDefined()
  })

  it('createGitServer returns McpServer', () => {
    const server = createGitServer('/tmp')
    expect(server).toBeDefined()
  })
})
