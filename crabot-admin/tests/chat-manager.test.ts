/**
 * ChatManager 单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ChatManager } from '../src/chat-manager.js'
import type { RpcClient } from '../src/core/module-base.js'
import type { ChatCallbackParams } from '../src/types.js'

describe('ChatManager', () => {
  const testDataDir = '/tmp/crabot-test-chat'
  let chatManager: ChatManager
  let mockRpcClient: RpcClient
  let mockFlowPort: () => number

  beforeEach(async () => {
    // 清理测试目录
    await fs.rm(testDataDir, { recursive: true, force: true })
    await fs.mkdir(testDataDir, { recursive: true })

    // Mock RPC Client
    mockRpcClient = {
      call: vi.fn(),
      resolve: vi.fn(),
      publishEvent: vi.fn(),
    } as any

    // Mock Flow Port
    mockFlowPort = vi.fn(() => 19300)

    // 创建 ChatManager 实例
    chatManager = new ChatManager(
      testDataDir,
      mockRpcClient,
      mockFlowPort,
      'test-jwt-secret'
    )

    await chatManager.loadData()
  })

  afterEach(async () => {
    chatManager.close()
    await fs.rm(testDataDir, { recursive: true, force: true })
  })

  describe('消息存储', () => {
    it('应该能够处理 chat_callback 并存储消息', async () => {
      const params: ChatCallbackParams = {
        request_id: 'req-001',
        reply_type: 'direct_reply',
        content: '你好，我是 AI 助手',
      }

      const result = await chatManager.handleChatCallback(params)

      expect(result.received).toBe(true)

      // 验证消息已存储
      const messages = chatManager.getMessages(10)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('assistant')
      expect(messages[0].content).toBe('你好，我是 AI 助手')
      expect(messages[0].request_id).toBe('req-001')
    })

    it('应该能够分页查询消息', async () => {
      // 添加多条消息（添加延迟确保不同时间戳）
      for (let i = 0; i < 5; i++) {
        await chatManager.handleChatCallback({
          request_id: `req-${i}`,
          reply_type: 'direct_reply',
          content: `消息 ${i}`,
        })
        // 添加 1ms 延迟确保时间戳不同
        await new Promise((resolve) => setTimeout(resolve, 1))
      }

      // 查询前 3 条
      const messages = chatManager.getMessages(3)
      expect(messages).toHaveLength(3)

      // 验证按时间倒序
      expect(messages[0].content).toBe('消息 4')
      expect(messages[1].content).toBe('消息 3')
      expect(messages[2].content).toBe('消息 2')
    })

    it('应该能够清空消息', async () => {
      await chatManager.handleChatCallback({
        request_id: 'req-001',
        reply_type: 'direct_reply',
        content: '测试消息',
      })

      expect(chatManager.getMessages(10)).toHaveLength(1)

      await chatManager.clearMessages()

      expect(chatManager.getMessages(10)).toHaveLength(0)
    })
  })

  describe('数据持久化', () => {
    it('应该能够保存和加载消息', async () => {
      await chatManager.handleChatCallback({
        request_id: 'req-001',
        reply_type: 'direct_reply',
        content: '持久化测试',
      })

      await chatManager.saveData()

      // 创建新实例并加载
      const newChatManager = new ChatManager(
        testDataDir,
        mockRpcClient,
        mockFlowPort,
        'test-jwt-secret'
      )
      await newChatManager.loadData()

      const messages = newChatManager.getMessages(10)
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('持久化测试')

      newChatManager.close()
    })

    it('应该能够处理不存在的数据文件', async () => {
      const emptyDir = path.join(testDataDir, 'empty')
      await fs.mkdir(emptyDir, { recursive: true })

      const newChatManager = new ChatManager(
        emptyDir,
        mockRpcClient,
        mockFlowPort,
        'test-jwt-secret'
      )

      // 不应该抛出错误
      await expect(newChatManager.loadData()).resolves.not.toThrow()

      const messages = newChatManager.getMessages(10)
      expect(messages).toHaveLength(0)

      newChatManager.close()
    })
  })

  describe('回复类型', () => {
    it('应该能够处理 task_created 回复', async () => {
      await chatManager.handleChatCallback({
        request_id: 'req-001',
        reply_type: 'task_created',
        content: '任务已创建',
        task_id: 'task-001',
      })

      const messages = chatManager.getMessages(10)
      expect(messages[0].task_id).toBe('task-001')
    })

    it('应该能够处理 task_completed 回复', async () => {
      await chatManager.handleChatCallback({
        request_id: 'req-001',
        reply_type: 'task_completed',
        content: '任务已完成',
        task_id: 'task-001',
      })

      const messages = chatManager.getMessages(10)
      expect(messages[0].content).toBe('任务已完成')
    })

    it('应该能够处理 task_failed 回复', async () => {
      await chatManager.handleChatCallback({
        request_id: 'req-001',
        reply_type: 'task_failed',
        content: '任务失败',
        task_id: 'task-001',
      })

      const messages = chatManager.getMessages(10)
      expect(messages[0].content).toBe('任务失败')
    })
  })
})
