/**
 * test-channel.cjs - 简单测试插件
 *
 * 用于验证 crabot-channel-host 的核心桥接机制：
 *   dispatchReplyWithBufferedBlockDispatcher → channel.message_received 事件
 *
 * 使用方式：
 *   OPENCLAW_PLUGIN_PATH=/path/to/test-channel.cjs \
 *   OPENCLAW_CONFIG='{}' \
 *   Crabot_MODULE_ID=channel-test \
 *   Crabot_PORT=19020 \
 *   node dist/main.js
 *
 * 启动后，插件每 10 秒发送一条模拟消息，可通过 Admin 事件日志观察。
 * 同时监听 HTTP POST /trigger（仅测试用）手动触发一条消息。
 */

'use strict'

const http = require('http')

const plugin = {
  gateway: {
    /**
     * @param {object} ctx
     * @param {object} ctx.cfg        - 插件配置（OPENCLAW_CONFIG 解析结果）
     * @param {object} ctx.runtime    - channelRuntime（由 ChannelHost 提供）
     * @param {AbortSignal} ctx.abortSignal
     * @param {object} ctx.account    - resolveAccount 返回值
     */
    async startAccount(ctx) {
      const { runtime, cfg, abortSignal, account } = ctx
      const accountId = account?.accountId ?? 'test-user-001'

      console.log('[TestPlugin] startAccount called')
      console.log('[TestPlugin] config:', JSON.stringify(cfg))

      let msgSeq = 0

      /**
       * 模拟一条入站消息
       */
      const simulateInboundMessage = async () => {
        msgSeq += 1
        const senderId = accountId
        const sessionKey = `test-session-${accountId}`
        const body = `Test message #${msgSeq} from TestPlugin`

        console.log(`[TestPlugin] Simulating inbound message: "${body}"`)

        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: {
            SenderId: senderId,
            SenderName: 'Test User',
            SenderUsername: 'testuser',
            SessionKey: sessionKey,
            AccountId: accountId,
            Provider: 'test',
            Body: body,
            ChatType: 'private',
          },
          cfg,
          dispatcherOptions: {
            deliver: async (payload, info) => {
              console.log(`[TestPlugin] Agent replied (${info?.kind ?? 'unknown'}):`, payload)
            },
          },
        })
      }

      // 启动时发送第一条消息
      await simulateInboundMessage().catch(console.error)

      // 每 30 秒发送一条消息（可通过 /trigger 手动触发）
      const intervalId = setInterval(() => {
        if (abortSignal.aborted) {
          clearInterval(intervalId)
          return
        }
        simulateInboundMessage().catch(console.error)
      }, 30_000)

      // 启动简单的 HTTP 触发器（端口 19099），方便手动测试
      const triggerServer = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/trigger') {
          await simulateInboundMessage().catch(console.error)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, seq: msgSeq }))
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      triggerServer.listen(19099, () => {
        console.log('[TestPlugin] Trigger server listening on port 19099')
        console.log('[TestPlugin] POST http://localhost:19099/trigger to send a test message')
      })

      // 等待 abort 信号
      await new Promise((resolve) => {
        abortSignal.addEventListener('abort', resolve, { once: true })
      })

      clearInterval(intervalId)
      triggerServer.close()
      console.log('[TestPlugin] startAccount ended')
    },
  },

  config: {
    /**
     * @param {unknown} cfg
     * @param {string|null} [accountId]
     */
    resolveAccount(cfg, accountId) {
      return {
        accountId: accountId ?? 'test-user-001',
        config: cfg ?? {},
      }
    },
  },
}

// 兼容 plugin-loader.ts 的各种导出格式
module.exports = plugin
module.exports.default = plugin
module.exports.gateway = plugin.gateway
module.exports.config = plugin.config
