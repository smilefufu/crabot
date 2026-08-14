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
    it('chat_callback 已退役：返回 retired 错误，不写消息', async () => {
      const params: ChatCallbackParams = {
        request_id: 'req-001',
        reply_type: 'direct_reply',
        content: '你好，我是 AI 助手',
      }

      await expect(chatManager.handleChatCallback(params)).rejects.toThrow(/retired/)
      expect(chatManager.getMessages(10)).toHaveLength(0)
    })

    it('send_message（delivery 事务）落库 assistant 消息', async () => {
      const result = await chatManager.handleSendMessage({
        session_id: 'admin-chat',
        delivery_id: 'd-store-1',
        content: { type: 'text', text: '你好，我是 AI 助手' },
      })
      expect(result.platform_message_id).toBeTruthy()
      const messages = chatManager.getMessages(10)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('assistant')
      expect(messages[0].content.text).toBe('你好，我是 AI 助手')
    })

    it('应该能够分页查询消息', async () => {
      // 添加多条消息（添加延迟确保不同时间戳）
      for (let i = 0; i < 5; i++) {
        await chatManager.handleSendMessage({
          session_id: 'admin-chat',
          delivery_id: `d-page-${i}`,
          content: { type: 'text', text: `消息 ${i}` },
        })
        // 添加 1ms 延迟确保时间戳不同
        await new Promise((resolve) => setTimeout(resolve, 1))
      }

      // 查询前 3 条
      const messages = chatManager.getMessages(3)
      expect(messages).toHaveLength(3)

      // 验证按时间倒序
      expect(messages[0].content.text).toBe('消息 4')
      expect(messages[1].content.text).toBe('消息 3')
      expect(messages[2].content.text).toBe('消息 2')
    })

    it('应该能够清空消息', async () => {
      await chatManager.handleSendMessage({
        session_id: 'admin-chat',
        delivery_id: 'd-clear-1',
        content: { type: 'text', text: '待清空' },
      })

      expect(chatManager.getMessages(10)).toHaveLength(1)

      await chatManager.clearMessages()

      expect(chatManager.getMessages(10)).toHaveLength(0)
    })
  })

  describe('数据持久化', () => {
    it('应该能够保存和加载消息', async () => {
      await chatManager.handleSendMessage({
        session_id: 'admin-chat',
        delivery_id: 'd-persist-1',
        content: { type: 'text', text: '持久化测试' },
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
      expect(messages[0].content.text).toBe('持久化测试')

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

  describe('回复类型（chat_callback 已退役）', () => {
    it('task_created/task_completed/task_failed 回复类型全部 retired 拒绝', async () => {
      for (const reply_type of ['task_created', 'task_completed', 'task_failed'] as const) {
        await expect(
          chatManager.handleChatCallback({ request_id: 'x', reply_type, content: 'x' })
        ).rejects.toThrow(/retired/)
      }
      expect(chatManager.getMessages(10)).toHaveLength(0)
    })
  })

  describe('handleSendMessage session_id 白名单（P4 manager task-8-brief additive）', () => {
    it('应该接受 admin-chat（默认行为不变）', async () => {
      const result = await chatManager.handleSendMessage({
        session_id: 'admin-chat',
        delivery_id: 'd-wl-1',
        content: { type: 'text', text: '你好' },
      })
      expect(result.platform_message_id).toBeTruthy()
    })

    it('应该接受新放开的 system-tasks（protocol-agent-v3 §4.4 保留系统任务线程）', async () => {
      const result = await chatManager.handleSendMessage({
        session_id: 'system-tasks',
        content: { type: 'text', text: '系统任务消息' },
      })
      expect(result.platform_message_id).toBeTruthy()
    })

    it('应该拒绝其它未知 session_id', async () => {
      await expect(
        chatManager.handleSendMessage({
          session_id: 'some-other-session',
          content: { type: 'text', text: '你好' },
        })
      ).rejects.toThrow('Unknown chat session: some-other-session')
    })
  })
})
