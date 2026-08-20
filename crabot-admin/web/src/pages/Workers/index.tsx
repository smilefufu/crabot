/**
 * Workers 配置页（P6-B §3.19.12）。
 *
 * 三方 worker 的登录凭证 crabot 不托管：要么在宿主机自行配好（existing_host，crabot 只
 * detect 登录态），要么用有限的页面选项配置（落成 admin_provider provider 引用）。
 * verify 是真实 CLI 最小 turn（可能产生费用），按钮有确认。
 */
import React, { useEffect, useState } from 'react'
import { Button } from '../../components/Common/Button'
import { Modal } from '../../components/Common/Modal'
import { Input } from '../../components/Common/Input'
import { Select } from '../../components/Common/Select'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import {
  workerManagementService,
  type WorkerImplementationConfig,
  type WorkerImplementationStatus,
  type CLIWorkerImplId,
  type WorkerImplId,
  type WorkerImplementationPolicy,
} from '../../services/worker-management'
import { providerService } from '../../services/provider'
import './WorkersPage.css'

type ImplId = 'builtin' | CLIWorkerImplId

const IMPLEMENTATIONS = ['builtin', 'claude-code', 'codex'] as const

const IMPL_LABEL: Record<ImplId, string> = {
  builtin: '内置执行器',
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

type ReadinessTone = 'ready' | 'attention' | 'blocked' | 'inactive' | 'unknown'

interface ReadinessView {
  label: string
  tone: ReadinessTone
  detail?: string
}

function readinessView(
  policy: WorkerImplementationPolicy | undefined,
  status: WorkerImplementationStatus | undefined,
  agentStatus: 'available' | 'unavailable',
): ReadinessView {
  if (agentStatus === 'unavailable') return { label: '状态未知', tone: 'unknown' }
  if (!policy?.enabled) return { label: '已停用', tone: 'inactive' }
  if (!status) return { label: '待检测', tone: 'unknown' }
  if (status.degraded) return { label: '已阻断', tone: 'blocked', detail: status.degraded }
  if (status.ready) return { label: '可派用', tone: 'ready' }
  if (status.global_install_detected) return { label: '需用户级安装', tone: 'attention' }
  if (!status.installed) return { label: '未安装', tone: 'attention' }
  if (!status.configured) return { label: '待配置连接', tone: 'attention' }
  return { label: '未就绪', tone: 'attention', detail: status.detail }
}

function installationLabel(impl: ImplId, status: WorkerImplementationStatus | undefined): string {
  if (impl === 'builtin') return '内置'
  if (!status) return '待检测'
  if (status.installed) return status.version ? `用户级 · ${status.version}` : '用户级安装'
  if (status.global_install_detected) return '仅检测到全局安装'
  return '未检测到用户级安装'
}

function connectionLabel(
  impl: ImplId,
  policy: WorkerImplementationPolicy | undefined,
  status: WorkerImplementationStatus | undefined,
): string {
  if (impl === 'builtin') return 'Agent 模型配置'
  const mode = status?.connection_mode ?? policy?.connection?.mode
  if (mode === 'existing_host') return '宿主机已有配置'
  if (mode === 'admin_provider') return '管理端连接'
  if (mode === 'native_account') return '原生账号'
  return '未配置'
}

function verificationLabel(status: WorkerImplementationStatus | undefined): { label: string; title?: string } {
  if (!status) return { label: '待检测' }
  if (status.verification_stale) {
    return { label: '待复验', title: '配置或版本已变更，建议重新验证；不影响当前派用状态。' }
  }
  return { label: VERIFICATION_LABEL[status.verification] ?? '—' }
}

interface DialogState {
  impl: CLIWorkerImplId
  method: 'existing_host' | 'setup_token' | 'custom'
  token: string
  endpoint: string
  apiKey: string
  modelId: string
}

function preferenceDraftsFor(config: WorkerImplementationConfig): Record<CLIWorkerImplId, string> {
  return {
    'claude-code': config.implementations['claude-code'].preference ?? '',
    codex: config.implementations.codex.preference ?? '',
  }
}

export const WorkersPage: React.FC = () => {
  const [config, setConfig] = useState<WorkerImplementationConfig | null>(null)
  const [statuses, setStatuses] = useState<WorkerImplementationStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [verifyImpl, setVerifyImpl] = useState<CLIWorkerImplId | null>(null)
  const [preferenceDrafts, setPreferenceDrafts] = useState<Record<CLIWorkerImplId, string>>({
    'claude-code': '',
    codex: '',
  })

  const [agentStatus, setAgentStatus] = useState<'available' | 'unavailable'>('available')

  const refresh = async () => {
    setError(null)
    try {
      const result = await workerManagementService.getAll()
      setConfig(result.config)
      setPreferenceDrafts(preferenceDraftsFor(result.config))
      setStatuses(result.statuses)
      setAgentStatus(result.agent_status)
      if (result.agent_status === 'unavailable') {
        setError(`Agent 不可用：${result.unavailable_reason ?? '未返回原因'}（显示的是已保存的期望配置，状态未知）`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const statusOf = (impl: ImplId) => statuses.find((s) => s.impl === impl)

  const applyConfig = async (impl: WorkerImplId, policy: WorkerImplementationPolicy, defaultImpl?: WorkerImplId) => {
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
      // 禁用当前 default 时，同一份 PUT 把 default 切回 builtin（协议：default 必须 enabled）。
      const effectiveDefault = defaultImpl ?? (
        (!policy.enabled && config.default_impl === impl) ? 'builtin' : config.default_impl
      )
      const updated = await workerManagementService.putConfig(config.revision, {
        default_impl: effectiveDefault,
        implementations: next,
      })
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
      throw err // saveConnection 依赖失败不关对话框/清孤儿 provider
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
        let provider: { id: string } | undefined
        try {
          provider = await providerService.createProvider({
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
        } catch (error) {
          // PUT 失败时清掉刚建的孤儿 provider（best-effort）。
          if (provider) await providerService.deleteProvider(provider.id).catch(() => {})
          throw error
        }
      }
      setDialog(null)
    } catch (err) {
      // 失败不关对话框（用户修正后可直接重试）。
      setError(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const runVerification = async (impl: CLIWorkerImplId) => {
    if (!config) return
    setBusy(true)
    setError(null)
    try {
      const result = await workerManagementService.startVerify(impl, config.revision)
      if (result.passed) setNotice('验证通过（真实最小 turn）')
      else setError(`验证失败: ${result.detail ?? '未返回原因'}`)
      await refresh()
    } catch (err) {
      setError(`验证失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const savePreference = async (impl: CLIWorkerImplId, policy: WorkerImplementationPolicy) => {
    const value = preferenceDrafts[impl].trim()
    if (value === (policy.preference ?? '')) {
      setPreferenceDrafts((drafts) => ({ ...drafts, [impl]: value }))
      return
    }
    const nextPolicy = { ...policy }
    if (value) nextPolicy.preference = value
    else delete nextPolicy.preference
    await applyConfig(impl, nextPolicy)
  }

  if (loading) return <MainLayout><Loading /></MainLayout>

  const renderCard = (impl: ImplId) => {
    const status = statusOf(impl)
    const policy = config?.implementations[impl]
    const isBuiltin = impl === 'builtin'
    const readiness = readinessView(policy, status, agentStatus)
    const verification = verificationLabel(status)
    return (
      <article
        key={impl}
        className={`worker-implementation${config?.default_impl === impl ? ' is-default' : ''}`}
      >
        <div className="worker-implementation__identity">
          <h2>{IMPL_LABEL[impl]}</h2>
          <span className={`worker-state worker-state--${readiness.tone}`} title={readiness.detail}>{readiness.label}</span>
        </div>
        <dl className="worker-implementation__facts">
          <div>
            <dt>安装</dt>
            <dd>{installationLabel(impl, status)}</dd>
          </div>
          <div>
            <dt>连接</dt>
            <dd>{connectionLabel(impl, policy, status)}</dd>
          </div>
          <div>
            <dt>验证</dt>
            <dd title={verification.title}>{verification.label}</dd>
          </div>
        </dl>
        {config && policy && (
          <div className="worker-implementation__actions">
            <label className="worker-choice">
              <input
                type="radio"
                name="worker-default"
                checked={config.default_impl === impl}
                disabled={busy || !policy.enabled}
                onChange={() => void applyConfig(impl, { ...policy, enabled: true }, impl)}
              />
              <span>默认派用</span>
            </label>
            {!isBuiltin && (
              <>
                <label className="worker-choice">
                  <input
                    type="checkbox"
                    checked={policy.enabled}
                    disabled={busy}
                    onChange={() => void applyConfig(impl, { ...policy, enabled: !policy.enabled })}
                  />
                  <span>启用</span>
                </label>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog({
                  impl: impl as CLIWorkerImplId, method: 'existing_host', token: '', endpoint: '', apiKey: '',
                  modelId: impl === 'claude-code' ? 'claude-sonnet-4-6' : '',
                })}>
                  配置连接
                </Button>
                {policy.enabled && (
                  <Button size="sm" disabled={busy} onClick={() => setVerifyImpl(impl as CLIWorkerImplId)}>验证</Button>
                )}
              </>
            )}
          </div>
        )}
        {(readiness.detail ?? status?.detail) && (
          <p className={`worker-implementation__notice${readiness.tone === 'blocked' ? ' is-danger' : ''}`}>
            {readiness.detail ?? status?.detail}
          </p>
        )}
        {!isBuiltin && config && policy && (
          <div className="worker-implementation__preference">
            <div className="worker-implementation__preference-field">
              <Input
                label="派用偏好"
                value={preferenceDrafts[impl]}
                placeholder="例如：优先用于代码审查"
                disabled={busy}
                onChange={(e) => setPreferenceDrafts((drafts) => ({ ...drafts, [impl]: e.target.value }))}
              />
              <Button
                size="sm"
                disabled={busy || preferenceDrafts[impl] === (policy.preference ?? '')}
                onClick={() => void savePreference(impl, policy).catch(() => {})}
              >保存偏好</Button>
            </div>
          </div>
        )}
      </article>
    )
  }

  return (
    <MainLayout>
      <div className="worker-config">
        <header className="worker-config__heading">
          <h1>Worker 配置</h1>
          {config && (
            <dl className="worker-config__summary" aria-label="Worker 配置概览">
              <div><dt>可派用</dt><dd>{IMPLEMENTATIONS.filter((impl) => readinessView(config.implementations[impl], statusOf(impl), agentStatus).tone === 'ready').length}</dd></div>
              <div><dt>默认派用</dt><dd>{IMPL_LABEL[config.default_impl]}</dd></div>
            </dl>
          )}
        </header>
        {error && <div className="worker-config__message is-error" role="alert">{error}</div>}
        {notice && <div className="worker-config__message is-success" role="status">{notice}</div>}
        <section className="worker-config__list" aria-label="Worker 实现">
          <div className="worker-config__columns" aria-hidden="true">
            <span>实现</span>
            <span>安装</span>
            <span>连接</span>
            <span>验证</span>
            <span>操作</span>
          </div>
          {IMPLEMENTATIONS.map(renderCard)}
        </section>

        <Modal
          open={dialog !== null}
          onClose={() => setDialog(null)}
          title={dialog ? `配置连接：${IMPL_LABEL[dialog.impl]}` : ''}
          footer={(
            <>
              <Button variant="secondary" onClick={() => setDialog(null)}>取消</Button>
              <Button
                disabled={busy || (dialog !== null && (
                  (dialog.method === 'setup_token' && (!dialog.token.trim() || !dialog.modelId.trim())) ||
                  (dialog.method === 'custom' && (!dialog.endpoint.trim() || !dialog.apiKey.trim() || !dialog.modelId.trim()))
                ))}
                onClick={() => void saveConnection()}
              >保存</Button>
            </>
          )}
        >
          {dialog && (
            <div className="worker-config__dialog-fields">
              <Select
                label="连接方式"
                value={dialog.method}
                onChange={(e) => setDialog({
                  ...dialog,
                  method: e.target.value as DialogState['method'],
                  ...(e.target.value === 'setup_token' && !dialog.modelId ? { modelId: 'claude-sonnet-4-6' } : {}),
                })}
                options={[
                  { value: 'existing_host', label: '使用宿主机已有配置' },
                  ...(dialog.impl === 'claude-code' ? [{ value: 'setup_token', label: '粘贴 Setup Token' }] : []),
                  { value: 'custom', label: '自定义服务地址与密钥' },
                ]}
              />
              {dialog.method === 'setup_token' && (
                <>
                  <Input
                    label="Setup Token"
                    type="password"
                    value={dialog.token}
                    onChange={(e) => setDialog({ ...dialog, token: e.target.value })}
                    placeholder="由 Claude CLI 签发的长期令牌"
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
                    label="服务地址"
                    value={dialog.endpoint}
                    onChange={(e) => setDialog({ ...dialog, endpoint: e.target.value })}
                    placeholder={dialog.impl === 'codex' ? 'https://your-mirror.example' : 'https://api.anthropic.com 或镜像'}
                  />
                  <Input
                    label="访问密钥"
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
                <p className="worker-config__host-note">使用宿主机已有的 CLI 配置；Crabot 不保存登录凭证。</p>
              )}
            </div>
          )}
        </Modal>
        <Modal
          open={verifyImpl !== null}
          onClose={() => setVerifyImpl(null)}
          title={verifyImpl ? `验证 ${IMPL_LABEL[verifyImpl]}` : ''}
          footer={(
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setVerifyImpl(null)}>取消</Button>
              <Button
                disabled={busy || verifyImpl === null}
                onClick={() => {
                  if (!verifyImpl) return
                  const impl = verifyImpl
                  setVerifyImpl(null)
                  void runVerification(impl)
                }}
              >开始验证</Button>
            </>
          )}
        >
          <p className="worker-config__verify-note">
            将在隔离临时目录中执行一次最小真实调用，可能消耗额度或产生费用。验证完成后会更新此实现的体检状态。
          </p>
        </Modal>
      </div>
    </MainLayout>
  )
}

export default WorkersPage
