import { describe, it, expect } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { MCPServerManager } from './mcp-skill-manager.js'

describe('Scrapling builtin registration', () => {
  it('新条目默认启用；重启保留关闭状态和自定义启动参数', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrapling-registry-'))
    try {
      const manager = new MCPServerManager(dir)
      await manager.initialize()
      await manager.registerBuiltins('/fixture/mcp-tools')
      const entry = manager.list().find(s => s.name === 'scrapling')!
      expect(entry.enabled).toBe(true)
      expect(entry.can_disable).toBe(true)
      await manager.update(entry.id, { enabled: false, command: 'custom-scrapling', args: ['mcp', '--http'] })
      const restarted = new MCPServerManager(dir)
      await restarted.initialize()
      await restarted.registerBuiltins('/moved/mcp-tools')
      expect(restarted.get(entry.id)).toMatchObject({ enabled: false, command: 'custom-scrapling', args: ['mcp', '--http'] })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
