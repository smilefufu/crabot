import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useNavigate } from 'react-router-dom'
import { api } from '../../services/api'
import { channelService } from '../../services/channel'
import { storage } from '../../utils/storage'
import { MainLayout } from '../../components/Layout/MainLayout'
import { useToast } from '../../contexts/ToastContext'
import type { ScannedPlugin } from '../../types'

type SessionStatus = 'idle' | 'connecting' | 'connected' | 'exited'

type ActionState =
  | { step: 'idle' }
  | { step: 'scanning' }
  | { step: 'found'; plugins: ScannedPlugin[] }
  | { step: 'not_found' }
  | { step: 'registering' }
  | { step: 'starting' }
  | { step: 'running'; instanceId: string }
  | { step: 'error'; message: string }

// 已知的 Channel 安装向导命令
const QUICK_CMDS = [
  { label: '飞书 (Feishu)', cmd: 'npx -y @larksuite/openclaw-lark-tools install' },
  { label: '微信 (WeChat)', cmd: 'npx -y @tencent-weixin/openclaw-weixin-cli@latest install' },
]

export function ChannelPty() {
  const termContainerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const stateDirRef = useRef<string>('')
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [actionState, setActionState] = useState<ActionState>({ step: 'idle' })
  const [instanceName, setInstanceName] = useState('')
  const [platform, setPlatform] = useState('')
  const navigate = useNavigate()
  const toast = useToast()

  const sendInput = (text: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'input', data: text }))
    termRef.current?.focus()
  }

  const handleScan = useCallback(async () => {
    const stateDir = stateDirRef.current
    if (!stateDir) return

    setActionState({ step: 'scanning' })
    try {
      const result = await channelService.scanStateDir(stateDir)
      if (result.plugins.length > 0) {
        const firstPlugin = result.plugins[0]
        setInstanceName(firstPlugin.name.replace(/^@\w+\//, ''))
        if (firstPlugin.platform !== 'unknown') {
          setPlatform(firstPlugin.platform)
        }
        setActionState({ step: 'found', plugins: result.plugins })
      } else {
        setActionState({ step: 'not_found' })
      }
    } catch (err) {
      setActionState({
        step: 'error',
        message: `扫描失败: ${err instanceof Error ? err.message : '未知错误'}`,
      })
    }
  }, [])

  const handleRegisterAndStart = async () => {
    if (!instanceName.trim()) {
      toast.error('请填写实例名称')
      return
    }

    setActionState({ step: 'registering' })
    try {
      const { instance } = await channelService.createInstance({
        implementation_id: 'channel-host',
        name: instanceName.trim(),
        platform,
        state_dir: stateDirRef.current,
        auto_start: true,
      })

      setActionState({ step: 'starting' })
      await channelService.startInstance(instance.id)

      // 轮询等待 running 或 failed（每 2s，最多 30s）
      const startTime = Date.now()
      const pollInterval = 2000
      const maxWait = 30000

      const poll = async (): Promise<void> => {
        if (Date.now() - startTime > maxWait) {
          setActionState({
            step: 'error',
            message: '启动超时，请前往管理页面检查状态',
          })
          return
        }

        try {
          const { instance: updated } = await channelService.getInstance(instance.id)
          if (updated.runtime_status === 'running') {
            setActionState({ step: 'running', instanceId: instance.id })
            return
          }
          if (updated.runtime_status === 'failed') {
            setActionState({
              step: 'error',
              message: '模块启动失败，请前往管理页面查看日志',
            })
            return
          }
        } catch {
          // 查询失败继续轮询
        }
        await new Promise((r) => setTimeout(r, pollInterval))
        return poll()
      }

      await poll()
    } catch (err) {
      setActionState({
        step: 'error',
        message: `操作失败: ${err instanceof Error ? err.message : '未知错误'}`,
      })
    }
  }

  useEffect(() => {
    if (!termContainerRef.current) return

    const term = new Terminal({
      theme: { background: '#0d1117', foreground: '#c9d1d9' },
      cursorBlink: true,
      fontFamily: 'monospace',
      rightClickSelectsWord: true,
    })
    termRef.current = term
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(termContainerRef.current)
    fitAddon.fit()

    // Ctrl+C/Cmd+C：有选中文本时复制，无选中时发送 SIGINT
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const isCopy = (e.ctrlKey || e.metaKey) && e.key === 'c' && e.type === 'keydown'
      if (isCopy && term.getSelection()) {
        navigator.clipboard.writeText(term.getSelection())
        return false // 不透传给 PTY
      }
      return true
    })

    setStatus('connecting')
    let roCleanup: (() => void) | null = null

    const startSession = async () => {
      const { session_id, state_dir } = await api.post<{
        session_id: string
        module_id: string
        state_dir: string
      }>('/channels/pty/create', {})

      stateDirRef.current = state_dir

      const token = storage.getToken()
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/pty/${session_id}?token=${token}`)
      wsRef.current = ws

      ws.onopen = () => setStatus('connected')
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as
          | { type: 'output'; data: string }
          | { type: 'exit'; exitCode: number }
          | { type: 'install_complete' }
        if (msg.type === 'output') {
          term.write(msg.data)
        } else if (msg.type === 'exit') {
          setStatus('exited')
          term.write(`\r\n\x1b[33m[进程已退出，代码: ${msg.exitCode}]\x1b[0m\r\n`)
        } else if (msg.type === 'install_complete') {
          // 安装标记文件写入，自动触发扫描
          handleScan()
        }
      }
      ws.onclose = () => {
        wsRef.current = null
        setStatus((s) => (s === 'connected' ? 'exited' : s))
      }

      term.onData((data: string) => ws.send(JSON.stringify({ type: 'input', data })))

      const ro = new ResizeObserver(() => {
        fitAddon.fit()
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      })
      ro.observe(termContainerRef.current!)
      roCleanup = () => ro.disconnect()
    }

    startSession().catch((e: Error) => {
      term.write(`\r\n\x1b[31m[启动失败: ${e.message}]\x1b[0m\r\n`)
      setStatus('exited')
    })

    return () => {
      wsRef.current?.close()
      wsRef.current = null
      termRef.current = null
      term.dispose()
      roCleanup?.()
    }
  }, [handleScan])

  const statusLabel = {
    idle: '',
    connecting: '连接中...',
    connected: '● 已连接',
    exited: '已退出',
  }[status]

  const actionDisabled = actionState.step === 'scanning' || actionState.step === 'registering' || actionState.step === 'starting'

  return (
    <MainLayout>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h2 style={{ margin: 0 }}>OpenClaw 安装终端</h2>
          <span style={{ color: status === 'connected' ? 'var(--success, #22c55e)' : 'var(--text-secondary, #6b7280)', fontSize: '14px' }}>
            {statusLabel}
          </span>
        </div>

        {/* 快速输入按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', whiteSpace: 'nowrap' }}>
            快速输入：
          </span>
          {QUICK_CMDS.map(({ label, cmd }) => (
            <button
              key={cmd}
              onClick={() => sendInput(cmd)}
              disabled={status !== 'connected'}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                border: '1px solid #374151',
                borderRadius: '4px',
                background: '#1f2937',
                color: '#e5e7eb',
                cursor: status === 'connected' ? 'pointer' : 'not-allowed',
                opacity: status === 'connected' ? 1 : 0.4,
              }}
            >
              {label}
            </button>
          ))}
          <span style={{ fontSize: '11px', color: 'var(--text-secondary, #9ca3af)' }}>
            （点击填入命令，按 Enter 执行）
          </span>
        </div>

        <div
          ref={termContainerRef}
          style={{ flex: 1, borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border, #374151)' }}
        />

        {/* Action Panel - 始终可见 */}
        <div style={{
          marginTop: '16px',
          padding: '16px',
          background: actionState.step === 'running' ? '#f0fdf4' : actionState.step === 'error' ? '#fef2f2' : '#f8fafc',
          border: `1px solid ${actionState.step === 'running' ? '#86efac' : actionState.step === 'error' ? '#fca5a5' : '#e2e8f0'}`,
          borderRadius: '8px',
        }}>
          <ActionPanel
            state={actionState}
            instanceName={instanceName}
            platform={platform}
            disabled={actionDisabled}
            onInstanceNameChange={setInstanceName}
            onPlatformChange={setPlatform}
            onScan={handleScan}
            onRegisterAndStart={handleRegisterAndStart}
            onNavigateConfig={() => navigate('/channels/config')}
            onRetry={handleScan}
          />
        </div>
      </div>
    </MainLayout>
  )
}

// ============================================================================
// Action Panel 子组件
// ============================================================================

interface ActionPanelProps {
  state: ActionState
  instanceName: string
  platform: string
  disabled: boolean
  onInstanceNameChange: (v: string) => void
  onPlatformChange: (v: string) => void
  onScan: () => void
  onRegisterAndStart: () => void
  onNavigateConfig: () => void
  onRetry: () => void
}

function ActionPanel({
  state,
  instanceName,
  platform,
  disabled,
  onInstanceNameChange,
  onPlatformChange,
  onScan,
  onRegisterAndStart,
  onNavigateConfig,
  onRetry,
}: ActionPanelProps) {
  switch (state.step) {
    case 'idle':
      return (
        <>
          <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#64748b' }}>
            安装完成后，点击检测已安装的插件。安装过程中检测会自动触发。
          </p>
          <button onClick={onScan} style={btnStyle('#3b82f6')}>
            检测插件
          </button>
        </>
      )

    case 'scanning':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Spinner />
          <span style={{ fontSize: '13px', color: '#64748b' }}>正在扫描已安装的插件...</span>
        </div>
      )

    case 'found':
      return (
        <>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', color: '#166534' }}>
            检测到 {state.plugins.length} 个插件
          </h3>
          <div style={{ marginBottom: '12px' }}>
            {state.plugins.map((p) => (
              <div key={p.name} style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                background: '#dcfce7',
                borderRadius: '4px',
                fontSize: '12px',
                color: '#166534',
                marginRight: '8px',
              }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <span style={{ color: '#15803d' }}>({p.platform})</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <FormField label="实例名称">
              <input
                type="text"
                value={instanceName}
                onChange={(e) => onInstanceNameChange(e.target.value)}
                placeholder="如：飞书工作群"
                style={inputStyle}
              />
            </FormField>
            <FormField label="平台">
              <input
                type="text"
                value={platform}
                onChange={(e) => onPlatformChange(e.target.value)}
                placeholder="如：feishu、wechat"
                style={inputStyle}
              />
            </FormField>
            <button
              onClick={onRegisterAndStart}
              disabled={disabled || !instanceName.trim()}
              style={btnStyle(disabled || !instanceName.trim() ? '#9ca3af' : '#16a34a', disabled || !instanceName.trim())}
            >
              注册并启动
            </button>
          </div>
        </>
      )

    case 'not_found':
      return (
        <>
          <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#92400e' }}>
            未检测到已安装的插件，请确认安装已完成。
          </p>
          <button onClick={onRetry} style={btnStyle('#f59e0b')}>
            重新检测
          </button>
        </>
      )

    case 'registering':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Spinner />
          <span style={{ fontSize: '13px', color: '#64748b' }}>正在注册 Channel 实例...</span>
        </div>
      )

    case 'starting':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Spinner />
          <span style={{ fontSize: '13px', color: '#64748b' }}>正在启动 Channel 模块...</span>
        </div>
      )

    case 'running':
      return (
        <>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', color: '#166534' }}>
            Channel 已成功启动
          </h3>
          <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#15803d' }}>
            插件已注册并启动运行。前往管理页面配置凭证等参数。
          </p>
          <button onClick={onNavigateConfig} style={btnStyle('#16a34a')}>
            前往管理页面
          </button>
        </>
      )

    case 'error':
      return (
        <>
          <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#dc2626' }}>
            {state.message}
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={onRetry} style={btnStyle('#ef4444')}>
              重试
            </button>
            <button onClick={onNavigateConfig} style={btnOutlineStyle}>
              前往管理页面
            </button>
          </div>
        </>
      )
  }
}

// ============================================================================
// 样式辅助
// ============================================================================

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '180px' }}>
      <label style={{ fontSize: '13px', color: '#374151', fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  )
}

function Spinner() {
  return (
    <div style={{
      width: '16px',
      height: '16px',
      border: '2px solid #e5e7eb',
      borderTopColor: '#3b82f6',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
    }} />
  )
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: '13px',
  border: '1px solid #d1d5db',
  borderRadius: '5px',
  outline: 'none',
  background: 'white',
}

function btnStyle(bg: string, isDisabled = false): React.CSSProperties {
  return {
    padding: '7px 16px',
    fontSize: '13px',
    background: bg,
    color: 'white',
    border: 'none',
    borderRadius: '5px',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    fontWeight: 500,
  }
}

const btnOutlineStyle: React.CSSProperties = {
  padding: '7px 16px',
  fontSize: '13px',
  border: '1px solid #d1d5db',
  borderRadius: '5px',
  background: 'white',
  color: '#374151',
  cursor: 'pointer',
}
