/**
 * RuntimeManager 测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { RuntimeManager } from './runtime-manager.js'
import type { ModulePackageInfo } from './types.js'

describe('RuntimeManager', () => {
  let runtimeManager: RuntimeManager

  beforeEach(() => {
    runtimeManager = new RuntimeManager('/test/crabot/root')
  })

  describe('checkRuntime', () => {
    it('should always return true for nodejs', async () => {
      const result = await runtimeManager.checkRuntime('nodejs')
      expect(result).toBe(true)
    })

    it('should always return true for binary', async () => {
      const result = await runtimeManager.checkRuntime('binary')
      expect(result).toBe(true)
    })

    it('should check uv availability for python', async () => {
      const result = await runtimeManager.checkRuntime('python')
      expect(typeof result).toBe('boolean')
    })
  })

  describe('getRuntimeInfo', () => {
    it('should return nodejs runtime info', async () => {
      const info = await runtimeManager.getRuntimeInfo('nodejs')
      expect(info.type).toBe('nodejs')
      expect(info.available).toBe(true)
      expect(info.version).toBe(process.version)
      expect(info.path).toBe(process.execPath)
    })

    it('should return binary runtime info', async () => {
      const info = await runtimeManager.getRuntimeInfo('binary')
      expect(info.type).toBe('binary')
      expect(info.available).toBe(true)
    })

    it('should return python runtime info', async () => {
      const info = await runtimeManager.getRuntimeInfo('python')
      expect(info.type).toBe('python')
      expect(typeof info.available).toBe('boolean')
    })
  })

  describe('createStartCommand', () => {
    it('should create nodejs start command', () => {
      const packageInfo: ModulePackageInfo = {
        module_id: 'test-module',
        module_type: 'agent',
        protocol_version: '1.0.0',
        name: 'Test Module',
        version: '1.0.0',
        runtime: { type: 'nodejs' },
        entry: 'dist/main.js',
        env: { TEST_VAR: 'test' },
      }

      const cmd = runtimeManager.createStartCommand(packageInfo, '/test/installed/path')

      expect(cmd.command).toBe(process.execPath)
      expect(cmd.args).toEqual(['dist/main.js'])
      expect(cmd.cwd).toBe('/test/installed/path')
      expect(cmd.env).toEqual({ TEST_VAR: 'test' })
    })

    it('should create python start command', () => {
      const packageInfo: ModulePackageInfo = {
        module_id: 'test-module',
        module_type: 'agent',
        protocol_version: '1.0.0',
        name: 'Test Module',
        version: '1.0.0',
        runtime: { type: 'python' },
        entry: 'main.py',
        env: { PYTHON_VAR: 'test' },
      }

      const cmd = runtimeManager.createStartCommand(packageInfo, '/test/installed/path')

      expect(cmd.command).toBe('uv')
      expect(cmd.args).toEqual(['run', 'python', 'main.py'])
      expect(cmd.cwd).toBe('/test/installed/path')
      expect(cmd.env).toEqual({ PYTHON_VAR: 'test' })
    })

    it('should create binary start command', () => {
      const packageInfo: ModulePackageInfo = {
        module_id: 'test-module',
        module_type: 'agent',
        protocol_version: '1.0.0',
        name: 'Test Module',
        version: '1.0.0',
        runtime: { type: 'binary' },
        entry: 'bin/module',
        env: {},
      }

      const cmd = runtimeManager.createStartCommand(packageInfo, '/test/installed/path')

      expect(cmd.command).toContain('bin/module')
      expect(cmd.args).toEqual([])
      expect(cmd.cwd).toBe('/test/installed/path')
    })

    it('should handle empty env', () => {
      const packageInfo: ModulePackageInfo = {
        module_id: 'test-module',
        module_type: 'agent',
        protocol_version: '1.0.0',
        name: 'Test Module',
        version: '1.0.0',
        runtime: { type: 'nodejs' },
        entry: 'dist/main.js',
      }

      const cmd = runtimeManager.createStartCommand(packageInfo, '/test/path')
      expect(cmd.env).toEqual({})
    })

    it('should preserve all env variables', () => {
      const packageInfo: ModulePackageInfo = {
        module_id: 'test-module',
        module_type: 'agent',
        protocol_version: '1.0.0',
        name: 'Test Module',
        version: '1.0.0',
        runtime: { type: 'nodejs' },
        entry: 'dist/main.js',
        env: {
          VAR1: 'value1',
          VAR2: 'value2',
          VAR3: 'value3',
        },
      }

      const cmd = runtimeManager.createStartCommand(packageInfo, '/test/path')

      expect(cmd.env).toEqual({
        VAR1: 'value1',
        VAR2: 'value2',
        VAR3: 'value3',
      })
    })
  })
})
