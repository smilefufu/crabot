/**
 * Admin Master Chat 集成测试
 *
 * 测试 WebSocket 连接、消息发送和 chat_callback 处理
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import * as fs from 'node:fs/promises'
import { WebSocket } from 'ws'
import { AdminModule } from '../src/index.js'
import type { ModuleConfig } from '../src/core/module-base.js'
import { newCredentialsFromPassword, writeCredentials } from '../src/credentials.js'

describe('Admin Master Chat 集成测试', () => {
  let adminModule: AdminModule
  let webPort: number
  let jwtToken: string
  let dataDir: string

  beforeAll(async () => {
    // 密码从 .env 迁到 credentials.json
    process.env.CRABOT_JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long'

    dataDir = await fs.mkdtemp('/tmp/crabot-test-admin-chat-')

    const cred = await newCredentialsFromPassword('test123', { is_temp: false, changed_via: 'start' })
    await writeCredentials(dataDir, cred)

    // 创建 Admin 模块实例
    const moduleConfig: ModuleConfig = {
      moduleId: 'admin-test',
      moduleType: 'admin',
      version: '1.0.0',
      protocolVersion: '0.1.0',
      port: 19999, // 测试端口
    }

    webPort = 3999 // 测试 Web 端口

    adminModule = new AdminModule(moduleConfig, {
      web_port: webPort,
      data_dir: dataDir,
      password_env: 'CRABOT_ADMIN_PASSWORD',
      jwt_secret_env: 'CRABOT_JWT_SECRET',
      token_ttl: 3600,
    })

    // 启动模块
    await adminModule.start()

    // 获取 JWT Token
    const loginResponse = await fetch(`http://localhost:${webPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test123' }),
    })

    const loginData = await loginResponse.json() as { token: string }
    jwtToken = loginData.token
  }, 30000)

  afterAll(async () => {
    if (adminModule) {
      await adminModule.stop()
    }
    if (dataDir) {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('应该能够通过 JWT 认证连接 WebSocket', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${webPort}/ws/chat?token=${jwtToken}`)

      ws.on('open', () => {
        ws.close()
        resolve()
      })

      ws.on('error', (error) => {
        reject(error)
      })

      setTimeout(() => reject(new Error('连接超时')), 5000)
    })
  })

  it('应该拒绝无效的 JWT token', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${webPort}/ws/chat?token=invalid-token`)

      ws.on('open', () => {
        ws.close()
        reject(new Error('不应该连接成功'))
      })

      ws.on('error', () => {
        // 预期会失败
        resolve()
      })

      setTimeout(() => resolve(), 2000)
    })
  })

  it('应该能够发送消息并写入聊天记录（chat_status processing 占位推送已退役，以落库为准）', async () => {
    const requestId = 'test-' + Date.now()
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${webPort}/ws/chat?token=${jwtToken}`)

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'chat_message',
          request_id: requestId,
          content: '测试消息',
        }))
        resolve()
      })

      ws.on('error', (error) => {
        reject(error)
      })

      setTimeout(() => reject(new Error('发送超时')), 5000)
    })

    // 轮询等待受理落库
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const response = await fetch(`http://localhost:${webPort}/api/chat/messages?limit=10`, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
        },
      })
      expect(response.status).toBe(200)
      const data = await response.json() as { messages: Array<{ request_id?: string }> }
      if (data.messages.some((m) => m.request_id === requestId)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('消息未写入聊天记录')
  })

  it('应该能够通过 REST API 查询聊天记录', async () => {
    const response = await fetch(`http://localhost:${webPort}/api/chat/messages?limit=10`, {
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
      },
    })

    expect(response.status).toBe(200)

    const data = await response.json() as { messages: any[] }
    expect(data).toHaveProperty('messages')
    expect(Array.isArray(data.messages)).toBe(true)
  })

  it('应该能够清空聊天记录', async () => {
    const response = await fetch(`http://localhost:${webPort}/api/chat/messages`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
      },
    })

    expect(response.status).toBe(204)

    // 验证已清空
    const getResponse = await fetch(`http://localhost:${webPort}/api/chat/messages?limit=10`, {
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
      },
    })

    const data = await getResponse.json() as { messages: any[] }
    expect(data.messages).toHaveLength(0)
  })

  it('chat_callback 已退役：只返回 retired 错误，不写消息', async () => {
    const callbackParams = {
      request_id: 'test-callback-' + Date.now(),
      reply_type: 'direct_reply',
      content: '这是一条测试回复',
    }

    const response = await fetch(`http://localhost:${adminModule['config'].port}/chat_callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req-' + Date.now(),
        source: 'flow-test',
        method: 'chat_callback',
        params: callbackParams,
        timestamp: new Date().toISOString(),
      }),
    })

    const body = await response.json() as { error?: { message?: string } }
    expect(JSON.stringify(body)).toContain('retired')

    // 退役路径不写任何消息
    const messagesResponse = await fetch(`http://localhost:${webPort}/api/chat/messages?limit=10`, {
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
      },
    })
    const messagesData = await messagesResponse.json() as { messages: any[] }
    const assistantMessage = messagesData.messages.find((m: any) => m.role === 'assistant' && m.content?.text === '这是一条测试回复')
    expect(assistantMessage).toBeUndefined()
  })
})
