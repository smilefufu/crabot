/**
 * PortAllocator 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PortAllocator } from './port-allocator.js'
import fs from 'node:fs/promises'

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
