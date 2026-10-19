/**
 * PortAllocator 单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PortAllocator } from './port-allocator.js'
import ModuleManager from './index.js'
import fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DATA_DIR = './test-data/port-allocator-test'
const TEST_PORT_START = 19901
const TEST_PORT_END = 19910

const TEST_PORT_RANGE_SIZE = TEST_PORT_END - TEST_PORT_START + 1

describe('PortAllocator', () => {
  let allocator: PortAllocator

  beforeEach(async () => {
    // 清理测试数据目录
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })

    allocator = new PortAllocator(
      {
        range_start: TEST_PORT_START,
        range_end: TEST_PORT_END,
      },
      TEST_DATA_DIR
    )
  })

  afterEach(async () => {
    await allocator.flush()
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('allocate', () => {
    it('should allocate a port within range', () => {
      const port = allocator.allocate('module-1')
      expect(port).toBeGreaterThanOrEqual(TEST_PORT_START)
      expect(port).toBeLessThanOrEqual(TEST_PORT_END)
    })

    it('should return same port for same module_id', () => {
      const port1 = allocator.allocate('module-same')
      const port2 = allocator.allocate('module-same')
      expect(port1).toBe(port2)
    })

    it('should allocate different ports for different module_ids', () => {
      const port1 = allocator.allocate('module-diff-1')
      const port2 = allocator.allocate('module-diff-2')
      expect(port1).not.toBe(port2)
    })

    it('should allocate sequential ports', () => {
      const ports: number[] = []
      for (let i = 0; i < 3; i++) {
        ports.push(allocator.allocate(`module-seq-${i}`))
      }
      expect(ports[0]).toBe(TEST_PORT_START)
      expect(ports[1]).toBe(TEST_PORT_START + 1)
      expect(ports[2]).toBe(TEST_PORT_START + 2)
    })

    it('should throw when port range exhausted', () => {
      // 消耗所有端口
      for (let i = 0; i < TEST_PORT_RANGE_SIZE; i++) {
        allocator.allocate(`module-exhaust-${i}`)
      }

      // 尝试分配更多端口应该抛出错误
      expect(() => allocator.allocate('module-exhaust-fail')).toThrow()
    })
  })

  describe('get', () => {
    it('should return allocated port for existing module', () => {
      const port = allocator.allocate('module-get-test')
      expect(allocator.get('module-get-test')).toBe(port)
    })

    it('should return undefined for non-existent module', () => {
      expect(allocator.get('module-nonexistent')).toBeUndefined()
    })
  })

  describe('release', () => {
    it('should release an allocated port', () => {
      const port = allocator.allocate('module-release')
      allocator.release('module-release')

      // 分配相同 module_id 应该获得相同端口（因为端口被释放并可以重新分配）
      const newPort = allocator.allocate('module-release')
      expect(newPort).toBe(port)
    })

    it('should handle releasing non-existent module', () => {
      // 不应该抛出错误
      expect(() => allocator.release('module-nonexistent')).not.toThrow()
    })
  })
})


describe('PortAllocator persistence during startup', () => {
  let directory: string
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(tmpdir(), 'crabot-port-persistence-')) })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) })

  it('keeps the previous complete file readable while its replacement is being written', async () => {
    const file = path.join(directory, 'port-allocations.json')
    const original = [{ module_id: 'admin-web', port: 19901, allocated_at: '2026-10-20T00:00:00.000Z' }]
    await fs.writeFile(file, JSON.stringify(original))
    const allocator = new PortAllocator({ range_start: 19901, range_end: 19910 }, directory)
    await allocator.initialize()
    let entered!: () => void, release!: () => void, finish!: () => void
    const writing = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const completed = new Promise<void>(resolve => { finish = resolve })
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, content) => {
      writeFileSync(target as string, '[')
      entered(); await held
      writeFileSync(target as string, content as string); finish()
    })
    allocator.allocate('crabot-agent')
    await writing
    let readable: unknown
    try { readable = JSON.parse(await fs.readFile(file, 'utf8')) }
    catch { readable = 'partial JSON' }
    finally { release(); await completed }
    await allocator.flush()
    expect(readable).toEqual(original)
    const restored = new PortAllocator({ range_start: 19901, range_end: 19910 }, directory)
    await restored.initialize()
    expect(restored.get('admin-web')).toBe(19901)
    expect(restored.get('crabot-agent')).toBe(19902)
  })

  it('does not let a delayed older snapshot replace newer allocations', async () => {
    const allocator = new PortAllocator({ range_start: 19901, range_end: 19910 }, directory)
    let entered!: () => void, release!: () => void
    const writing = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined)
    let writes = 0
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, content) => {
      if (++writes === 1) { entered(); await held }
      writeFileSync(target as string, content as string)
    })
    allocator.allocate('admin-web'); await writing
    allocator.allocate('crabot-agent')
    // A concurrent writer can finish the shorter/newer snapshot while the first is paused.
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    release(); await allocator.flush()
    const restored = new PortAllocator({ range_start: 19901, range_end: 19910 }, directory)
    await restored.initialize()
    expect(restored.get('admin-web')).toBe(19901)
    expect(restored.get('crabot-agent')).toBe(19902)
  })

  it('retains the last complete file on publication failure and permits a later save', async () => {
    const file = path.join(directory, 'port-allocations.json'), original = '[]'
    await fs.writeFile(file, original)
    const allocator = new PortAllocator({ range_start: 19901, range_end: 19910 }, directory)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    allocator.allocate('admin-web')
    await allocator.flush()
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    expect(await fs.readdir(directory)).toEqual(['port-allocations.json'])
    allocator.allocate('crabot-agent')
    await allocator.flush()
    const restored = new PortAllocator({ range_start: 19901, range_end: 19910 }, directory)
    await restored.initialize()
    expect(restored.get('admin-web')).toBe(19901)
    expect(restored.get('crabot-agent')).toBe(19902)
  })

  it('finishes pending port publication before MM shutdown completes', async () => {
    const mm = new ModuleManager({ modules: [] }, directory) as any
    let entered!: () => void, release!: () => void
    const writing = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const write = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => { entered(); await held; return write(...args) })
    mm.portAllocator.allocate('admin-web'); await writing
    let stopped = false
    const stop = mm.stop().then(() => { stopped = true })
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
    const finishedEarly = stopped
    release(); await stop
    await mm.portAllocator.flush()
    expect(finishedEarly).toBe(false)
    expect(JSON.parse(await fs.readFile(path.join(directory, 'port-allocations.json'), 'utf8')))
      .toMatchObject([{ module_id: 'admin-web' }])
  })
})
