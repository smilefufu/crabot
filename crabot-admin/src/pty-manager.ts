/**
 * PTY 会话管理器 - 支持 Web CLI 终端
 *
 * 通过 node-pty 创建伪终端进程，配合 WebSocket 实现浏览器双向 I/O。
 * 主要用于运行 OpenClaw 向导等交互式 CLI 工具。
 */

import * as pty from 'node-pty'
import { WebSocketServer, WebSocket } from 'ws'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

interface PtySession {
  pty: pty.IPty
  moduleId: string
  stateDir: string
  ws: WebSocket | null
  outputBuffer: string // 历史输出（重连补发，限 100KB）
  markerWatchPath?: string // .install-complete 标记文件路径
}

export class PtyManager {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly sessions = new Map<string, PtySession>()

  constructor(
    private readonly jwtSecret: string,
    private readonly mmPort: number,
    private readonly verifyJwt: (token: string, secret: string) => unknown
  ) {
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage, sessionId: string) => {
      this.attachWebSocket(ws, sessionId)
    })
  }

  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const token = url.searchParams.get('token')
    if (!token || !this.verifyJwt(token, this.jwtSecret)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const sessionId = url.pathname.split('/').pop() ?? ''
    if (!this.sessions.has(sessionId)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req, sessionId)
    })
  }

  createSession(moduleId: string, stateDir: string, initCmd?: string): string {
    const sessionId = crypto.randomUUID()
    fs.mkdirSync(stateDir, { recursive: true })

    const binDir = process.env.CHANNEL_HOST_BIN_DIR ??
      path.resolve(__dirname, '..', '..', 'crabot-channel-host', 'bin')

    // 构建 session 专属 bin 目录，为 openclaw.js 创建无扩展名的 wrapper
    // bash 不识别 .js 扩展名，需要 `openclaw`（无扩展）才能作为命令调用
    const sessionBin = path.join(stateDir, '.bin')
    fs.mkdirSync(sessionBin, { recursive: true })
    const openshimJs = path.join(binDir, 'openclaw.js')
    const openshimLink = path.join(sessionBin, 'openclaw')
    if (fs.existsSync(openshimJs) && !fs.existsSync(openshimLink)) {
      fs.writeFileSync(openshimLink, `#!/bin/sh\nexec node "${openshimJs}" "$@"\n`, { mode: 0o755 })
    }

    const newPath = `${sessionBin}${path.delimiter}${process.env.PATH ?? ''}`

    const ptyProcess = pty.spawn('bash', [], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: stateDir,
      env: {
        ...process.env,
        PATH: newPath,
        OPENCLAW_STATE_DIR: stateDir,
        CRABOT_MM_PORT: String(this.mmPort),
        CRABOT_MODULE_ID: moduleId,
      },
    })

    const session: PtySession = {
      pty: ptyProcess,
      moduleId,
      stateDir,
      ws: null,
      outputBuffer: '',
    }
    this.sessions.set(sessionId, session)

    ptyProcess.onData((data: string) => {
      session.outputBuffer += data
      if (session.outputBuffer.length > 100_000) {
        session.outputBuffer = session.outputBuffer.slice(-50_000)
      }
      session.ws?.send(JSON.stringify({ type: 'output', data }))
    })

    ptyProcess.onExit(({ exitCode }) => {
      this.unwatchMarker(session)
      session.ws?.send(JSON.stringify({ type: 'exit', exitCode }))
      setTimeout(() => this.sessions.delete(sessionId), 10_000)
    })

    // 监听 .install-complete 标记文件（openclaw shim 写入）
    this.watchInstallMarker(session)

    // 等 bash 就绪后自动执行初始命令
    if (initCmd) {
      setTimeout(() => ptyProcess.write(initCmd + '\r'), 500)
    }

    return sessionId
  }

  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      this.unwatchMarker(session)
      session.pty.kill()
      this.sessions.delete(sessionId)
    }
  }

  private watchInstallMarker(session: PtySession): void {
    const markerPath = path.join(session.stateDir, '.install-complete')
    session.markerWatchPath = markerPath

    fs.watchFile(markerPath, { interval: 1000 }, (curr) => {
      // curr.size > 0 表示文件已被写入
      if (curr.size > 0) {
        session.ws?.send(JSON.stringify({ type: 'install_complete' }))
        this.unwatchMarker(session)
      }
    })
  }

  private unwatchMarker(session: PtySession): void {
    if (session.markerWatchPath) {
      fs.unwatchFile(session.markerWatchPath)
      session.markerWatchPath = undefined
    }
  }

  private attachWebSocket(ws: WebSocket, sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      ws.close()
      return
    }

    session.ws = ws

    // 补发历史输出
    if (session.outputBuffer) {
      ws.send(JSON.stringify({ type: 'output', data: session.outputBuffer }))
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as
          | { type: 'input'; data: string }
          | { type: 'resize'; cols: number; rows: number }
        if (msg.type === 'input') {
          session.pty.write(msg.data)
        } else if (msg.type === 'resize') {
          session.pty.resize(msg.cols, msg.rows)
        }
      } catch {
        // 忽略非法消息
      }
    })

    ws.on('close', () => {
      if (session.ws === ws) session.ws = null
    })
  }
}
