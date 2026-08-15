/**
 * Workers 配置页（P6-B §3.19.12）。
 *
 * 三方 worker 的登录凭证 crabot 不托管：要么在宿主机自行配好（existing_host，crabot 只
 * detect 登录态），要么用有限的页面选项配置（落成 admin_provider provider 引用）。
 * verify 是真实 CLI 最小 turn（可能产生费用），按钮有确认。
 * P6-C 前 default/preference 控件不开放。
 */
import React, { useEffect, useState } from 'react'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Modal } from '../../components/Common/Modal'
import { Input } from '../../components/Common/Input'
import { Select } from '../../components/Common/Select'
import { Loading } from '../../components/Common/Loading'
import {
  workerManagementService,
  type WorkerImplementationConfig,
  type WorkerImplementationStatus,
  type CLIWorkerImplId,
  type WorkerImplementationPolicy,
} from '../../services/worker-management'
import { providerService } from '../../services/provider'

type ImplId = 'builtin' | CLIWorkerImplId

const IMPL_LABEL: Record<ImplId, string> = {
  builtin: 'Builtin（内置）',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

const VERIFICATION_LABEL: Record<string, string> = {
  never: '未验证',
  running: '验证中',
  passed: '已通过',
  failed: '失败',
  grandfathered: '迁移继承',
}

interface DialogState {
  impl: CLIWorkerImplId
  method: 'existing_host' | 'setup_token' | 'custom'
  token: string
  endpoint: string
  apiKey: string
  modelId: string
}

export const WorkersPage: React.FC = () => {
  const [config, setConfig] = useState<WorkerImplementationConfig | null>(null)
  const [statuses, setStatuses] = useState<WorkerImplementationStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)

  const refresh = async () => {
    setError(null)
    try {
      const [cfg, sts] = await Promise.all([
        workerManagementService.getConfig(),
        workerManagementService.listStatus().catch(() => [] as WorkerImplementationStatus[]),
      ])
      setConfig(cfg)
      setStatuses(sts)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const statusOf = (impl: ImplId) => statuses.find((s) => s.impl === impl)

  const applyConfig = async (impl: CLIWorkerImplId, policy: WorkerImplementationPolicy) => {
    if (!config) return
    setBusy(true)
    setNotice(null)
    try {
      const next = {
        builtin: { ...config.implementations.builtin },
        'claude-code': { ...config.implementations['claude-code'] },
        codex: { ...config.implementations.codex },
      }
      next[impl] = policy
      const updated = await workerManagementService.putConfig(config.revision, next)
      setConfig(updated)
      setNotice('已保存')
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('409') || msg.includes('revision')) {
        setError('配置已被并发修改，已为你刷新，请重试')
        await refresh()
      } else {
        setError(`保存失败: ${msg}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const saveConnection = async () => {
    if (!dialog) return
    const { impl, method, token, endpoint, apiKey, modelId } = dialog
    setBusy(true)
    setError(null)
    try {
      if (method === 'existing_host') {
        await applyConfig(impl, { enabled: true, connection: { mode: 'existing_host' } })
      } else {
        const isToken = method === 'setup_token'
        const provider = await providerService.createProvider({
          name: `worker-${impl}-${isToken ? 'setup-token' : 'custom'}-${Date.now() % 100000}`,
          type: 'custom',
          format: impl === 'claude-code' ? 'anthropic' : 'openai-responses',
          endpoint: isToken ? 'https://api.anthropic.com' : endpoint,
          api_key: isToken ? token : apiKey,
          models: [{ model_id: modelId, display_name: modelId, type: 'llm' }],
        } as never)
        await applyConfig(impl, {
          enabled: true,
          connection: { mode: 'admin_provider', provider_id: provider.id, model_id: modelId },
        })
      }
      setDialog(null)
    } catch (err) {
      setError(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const runOperation = async (impl: CLIWorkerImplId, action: 'install' | 'verify') => {
    if (!config) return
    if (action === 'verify' && !window.confirm('verify 会在隔离临时目录用目标 CLI 跑一次最小真实 turn（消耗少量额度/费用）。继续？')) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await workerManagementService.startOperation(impl, action, config.revision)
      if (action === 'verify') {
        if (result.passed) setNotice('验证通过（真实最小 turn）')
        else setError(`验证失败: ${result.detail ?? 'unknown'}`)
      } else {
        setNotice(`安装完成: ${result.version ?? ''}`)
      }
      await refresh()
    } catch (err) {
      setError(`${action} 失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />

  const renderCard = (impl: ImplId) => {
    const status = statusOf(impl)
    const policy = config?.implementations[impl]
    const isBuiltin = impl === 'builtin'
    return (
      <Card
        key={impl}
        title={IMPL_LABEL[impl]}
        actions={status ? (
          <span className={status.ready ? 'text-success' : 'text-secondary'}>
            {status.ready ? '● ready' : '○ not ready'}
          </span>
        ) : <span className="text-secondary">unknown</span>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            安装: {status?.installed ? `${status.version ?? '?'}（${status.install_source === 'managed' ? 'Crabot 托管' : '系统'}）` : '未安装'}
            {'　'}连接: {policy?.connection?.mode === 'admin_provider' ? '页面配置' : policy?.connection?.mode === 'existing_host' ? '宿主机配置' : '—'}
            {'　'}验证: {VERIFICATION_LABEL[status?.verification ?? ''] ?? '—'}
            {'　'}启用: {policy?.enabled ? '是' : '否'}
          </div>
          {status?.detail && <div className="text-secondary" style={{ fontSize: 13 }}>{status.detail}</div>}
          {!isBuiltin && config && policy && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void runOperation(impl, 'install')}>
                {status?.install_source === 'managed' ? '升级/重装（托管）' : '安装（托管）'}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog({
                impl, method: 'existing_host', token: '', endpoint: '', apiKey: '',
                modelId: impl === 'claude-code' ? 'claude-sonnet-4-6' : '',
              })}>
                配置连接
              </Button>
              {policy.enabled && (
                <Button size="sm" disabled={busy} onClick={() => void runOperation(impl, 'verify')}>验证</Button>
              )}
              {policy.enabled ? (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void applyConfig(impl, { enabled: false, ...(policy.connection ? { connection: policy.connection } : {}) })}>禁用</Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => void applyConfig(impl, { enabled: true, ...(policy.connection ? { connection: policy.connection } : {}) })}>启用</Button>
              )}
            </div>
          )}
        </div>
      </Card>
    )
  }

  return (
    <div style={{ padding: 24, maxWidth: 880 }}>
      <h2>Worker 配置</h2>
      <p className="text-secondary" style={{ marginBottom: 16 }}>
        三方 worker 的登录凭证不由 Crabot 托管登录流程：可在宿主机自行配置（existing_host，Crabot 只检测登录态），
        或用「配置连接」里的有限选项在页面配置。配置后需「验证」通过才会被用于派活。
      </p>
      {error && <p className="text-danger" style={{ marginBottom: 12 }}>{error}</p>}
      {notice && <p className="text-success" style={{ marginBottom: 12 }}>{notice}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {(['builtin', 'claude-code', 'codex'] as const).map(renderCard)}
      </div>

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog ? `配置连接：${IMPL_LABEL[dialog.impl]}` : ''}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>取消</Button>
            <Button disabled={busy} onClick={() => void saveConnection()}>保存</Button>
          </>
        )}
      >
        {dialog && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Select
              label="连接方式"
              value={dialog.method}
              onChange={(e) => setDialog({
                ...dialog,
                method: e.target.value as DialogState['method'],
                ...(e.target.value === 'setup_token' && !dialog.modelId ? { modelId: 'claude-sonnet-4-6' } : {}),
              })}
              options={[
                { value: 'existing_host', label: '使用宿主机已配置（existing_host）' },
                ...(dialog.impl === 'claude-code' ? [{ value: 'setup_token', label: '粘贴 setup-token（Claude 订阅签发）' }] : []),
                { value: 'custom', label: '自定义 BASE_URL + KEY' },
              ]}
            />
            {dialog.method === 'setup_token' && (
              <>
                <Input
                  label="setup-token"
                  type="password"
                  value={dialog.token}
                  onChange={(e) => setDialog({ ...dialog, token: e.target.value })}
                  placeholder="claude setup-token 生成的长效 token"
                />
                <Input
                  label="模型 ID"
                  value={dialog.modelId}
                  onChange={(e) => setDialog({ ...dialog, modelId: e.target.value })}
                />
              </>
            )}
            {dialog.method === 'custom' && (
              <>
                <Input
                  label="BASE_URL"
                  value={dialog.endpoint}
                  onChange={(e) => setDialog({ ...dialog, endpoint: e.target.value })}
                  placeholder={dialog.impl === 'codex' ? 'https://your-mirror.example' : 'https://api.anthropic.com 或镜像'}
                />
                <Input
                  label="API KEY"
                  type="password"
                  value={dialog.apiKey}
                  onChange={(e) => setDialog({ ...dialog, apiKey: e.target.value })}
                />
                <Input
                  label="模型 ID"
                  value={dialog.modelId}
                  onChange={(e) => setDialog({ ...dialog, modelId: e.target.value })}
                  placeholder={dialog.impl === 'codex' ? 'gpt-5.6' : 'claude-sonnet-4-6'}
                />
              </>
            )}
            {dialog.method === 'existing_host' && (
              <p className="text-secondary" style={{ fontSize: 13 }}>
                使用宿主机上已安装并登录/配置好的 CLI。Crabot 不保存其登录凭证，只检测登录态。
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

export default WorkersPage
