/**
 * 备份导入向导。
 *
 * 上传归档后自动识别来源：
 *   - Crabot 备份  → Crabot 原生导入分支（类别选择 + 冲突策略 + 执行）
 *   - OpenClaw 备份 → OpenClaw 迁移分支（原有四步流程）
 *
 * 视觉对齐 Admin 设计系统（见 OpenClawImportWizard.css）。
 */
import React, { useMemo, useRef, useState } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { useToast } from '../../contexts/ToastContext'
import {
  openclawImportService,
  type BackupOverview,
  type ImportSelections,
  type ImportSummary as OciImportSummary,
} from '../../services/openclawImport'
import {
  uploadForImportOverview,
  executeCrabotImport,
  type ImportOverview,
  type CrabotImportSummary,
} from '../../services/backupImport'
import './OpenClawImportWizard.css'

// ── OpenClaw 工具 ─────────────────────────────────────────

const PROVIDER_SKIP_LABEL: Record<string, string> = {
  oauth: 'OAuth 凭证无法迁移，请在 crabot 重新配置',
  'secret-ref': '密钥为引用，备份中无明文，请重新填写',
  'unsupported-format': 'crabot 不支持的类型',
}

const SKIP_REASON_LABEL: Record<string, string> = {
  conflict: 'crabot 已存在同名，已跳过',
  'not-migratable': '不可迁移',
  'missing-secret': '密钥不在备份中',
  'invalid-name': '实例名不合法（含大写/点号等）',
}

// ── Crabot 类别标签 ────────────────────────────────────────

const CRABOT_CATEGORY_LABELS: Record<string, string> = {
  config: '配置（模型 / Agent / 模板 / MCP）',
  channels: '渠道与朋友（含权限）',
  skills: '技能',
  memory: '长期记忆',
  tasks: '任务与日程',
}

function categoryLabel(key: string): string {
  return CRABOT_CATEGORY_LABELS[key] ?? key
}

// ── 步骤标题（按当前分支动态算）─────────────────────────────

const STEP_TITLES_OCI = ['上传与解析', '配置类', '内容类', '预览与执行']
const STEP_TITLES_CRABOT = ['上传与识别', '选择内容', '执行导入']

// ── 主向导 ────────────────────────────────────────────────

type WizardBranch = 'none' | 'crabot' | 'openclaw'

export const OpenClawImportWizard: React.FC = () => {
  const toast = useToast()

  // 公共：上传步骤
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [branch, setBranch] = useState<WizardBranch>('none')

  // Crabot 分支状态
  const [crabotStep, setCrabotStep] = useState(0) // 0=上传, 1=选择, 2=结果
  const [stagedId, setStagedId] = useState('')
  const [availableCategories, setAvailableCategories] = useState<string[]>([])
  const [selCategories, setSelCategories] = useState<Set<string>>(new Set())
  const [onConflict, setOnConflict] = useState<'skip' | 'overwrite'>('skip')
  const [crabotSummary, setCrabotSummary] = useState<CrabotImportSummary | null>(null)

  // OpenClaw 分支状态
  const [ociStep, setOciStep] = useState(0)
  const [ociToken, setOciToken] = useState('')
  const [ociOverview, setOciOverview] = useState<BackupOverview | null>(null)
  const [ociSummary, setOciSummary] = useState<OciImportSummary | null>(null)

  const [selProviders, setSelProviders] = useState<Set<string>>(new Set())
  const [selChannels, setSelChannels] = useState<Set<string>>(new Set())
  const [selMcp, setSelMcp] = useState<Set<string>>(new Set())
  const [selSkills, setSelSkills] = useState<Set<string>>(new Set())
  const [importMemory, setImportMemory] = useState(false)
  const [importWorkspace, setImportWorkspace] = useState(false)

  const channelKey = (c: { source_channel: string; account_id?: string }) =>
    `${c.source_channel}:${c.account_id ?? 'default'}`

  function toggle(set: Set<string>, key: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  // ── 上传：探测 product ────────────────────────────────

  async function handleUpload() {
    if (!file) return
    setBusy(true)
    try {
      const overview: ImportOverview = await uploadForImportOverview(file)

      if (overview.product === 'crabot') {
        setBranch('crabot')
        setStagedId(overview.staged_id)
        setAvailableCategories(overview.categories)
        setSelCategories(new Set(overview.categories))
        setCrabotStep(1)
        toast.success('Crabot 备份识别成功')
      } else {
        // openclaw：需要再上传一次到 openclaw-import/parse
        setBranch('openclaw')
        try {
          const res = await openclawImportService.parseBackup(file)
          setOciToken(res.token)
          setOciOverview(res.overview)
          setSelProviders(new Set(res.overview.providers.filter((p) => p.migratable).map((p) => p.source_name)))
          setSelChannels(
            new Set(
              res.overview.channels
                .filter((c) => c.migratable && c.credentials === 'available')
                .map(channelKey),
            ),
          )
          setSelMcp(new Set(res.overview.mcpServers.filter((m) => m.migratable).map((m) => m.source_name)))
          setSelSkills(new Set(res.overview.skills))
          setImportMemory(res.overview.memory.present)
          setImportWorkspace(false)
          setOciStep(1)
          toast.success('OpenClaw 备份解析成功')
        } catch (err) {
          setBranch('none')
          toast.error(err instanceof Error ? err.message : 'OpenClaw 备份解析失败')
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '识别备份失败')
    } finally {
      setBusy(false)
    }
  }

  // ── Crabot 分支：执行导入 ─────────────────────────────

  async function handleCrabotExecute() {
    setBusy(true)
    try {
      const result = await executeCrabotImport({
        staged_id: stagedId,
        categories: [...selCategories],
        on_conflict: onConflict,
      })
      setCrabotSummary(result)
      setCrabotStep(2)
      const ok = result.results.filter((r) => r.status === 'ok' || r.status === 'imported' || r.status === 'created').length
      toast.success(`导入完成：成功 ${ok} 项`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  // ── OpenClaw 分支：执行导入 ────────────────────────────

  const ociSelections: ImportSelections = useMemo(() => {
    const channels = (ociOverview?.channels ?? [])
      .filter((c) => selChannels.has(channelKey(c)))
      .map((c) => ({ source_channel: c.source_channel, account_id: c.account_id ?? 'default' }))
    return {
      providers: [...selProviders],
      channels,
      mcp: [...selMcp],
      skills: [...selSkills],
      memory: importMemory,
      workspace: importWorkspace,
    }
  }, [ociOverview, selProviders, selChannels, selMcp, selSkills, importMemory, importWorkspace])

  async function handleOciExecute() {
    setBusy(true)
    try {
      const result = await openclawImportService.executeImport(ociToken, ociSelections)
      setOciSummary(result)
      setOciStep(3)
      toast.success(`导入完成：成功 ${result.results.filter((r) => r.status === 'imported').length} 项`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  // ── 重置（回到上传步）─────────────────────────────────

  function handleReset() {
    setBranch('none')
    setFile(null)
    setCrabotStep(0)
    setCrabotSummary(null)
    setOciStep(0)
    setOciSummary(null)
  }

  // ── 步骤条数据 ────────────────────────────────────────

  const stepTitles = branch === 'openclaw' ? STEP_TITLES_OCI : STEP_TITLES_CRABOT
  const currentStep = branch === 'openclaw' ? ociStep : branch === 'crabot' ? crabotStep : 0

  return (
    <MainLayout>
      <div className="oci-wrap">
        <header className="oci-head">
          <div className="oci-head-mark">📦</div>
          <div>
            <h1 className="oci-title">导入</h1>
            <p className="oci-subtitle">
              支持从 <strong>Crabot 备份</strong> 或 <strong>OpenClaw 备份</strong> 导入。
            </p>
          </div>
        </header>

        <Stepper step={currentStep} titles={stepTitles} />

        {/* ── 上传步（公共）─── */}
        {branch === 'none' && (
          <UploadStep file={file} setFile={setFile} busy={busy} onUpload={handleUpload} />
        )}

        {/* ── Crabot 分支 ─── */}
        {branch === 'crabot' && crabotStep === 1 && !crabotSummary && (
          <CrabotSelectStep
            categories={availableCategories}
            selCategories={selCategories}
            onToggleCategory={(k) => toggle(selCategories, k, setSelCategories)}
            onConflict={onConflict}
            setOnConflict={setOnConflict}
            busy={busy}
            onBack={handleReset}
            onExecute={handleCrabotExecute}
          />
        )}
        {branch === 'crabot' && crabotStep === 2 && crabotSummary && (
          <CrabotResultStep summary={crabotSummary} onReset={handleReset} />
        )}

        {/* ── OpenClaw 分支 ─── */}
        {branch === 'openclaw' && ociStep === 1 && ociOverview && (
          <ConfigStep
            overview={ociOverview}
            selProviders={selProviders}
            selChannels={selChannels}
            onToggleProvider={(k) => toggle(selProviders, k, setSelProviders)}
            onToggleChannel={(k) => toggle(selChannels, k, setSelChannels)}
            channelKey={channelKey}
            onBack={handleReset}
            onNext={() => setOciStep(2)}
          />
        )}
        {branch === 'openclaw' && ociStep === 2 && ociOverview && (
          <ContentStep
            overview={ociOverview}
            selMcp={selMcp}
            selSkills={selSkills}
            importMemory={importMemory}
            importWorkspace={importWorkspace}
            onToggleMcp={(k) => toggle(selMcp, k, setSelMcp)}
            onToggleSkill={(k) => toggle(selSkills, k, setSelSkills)}
            setImportMemory={setImportMemory}
            setImportWorkspace={setImportWorkspace}
            onBack={() => setOciStep(1)}
            onNext={() => setOciStep(3)}
          />
        )}
        {branch === 'openclaw' && ociStep === 3 && !ociSummary && (
          <PreviewStep selections={ociSelections} busy={busy} onBack={() => setOciStep(2)} onExecute={handleOciExecute} />
        )}
        {branch === 'openclaw' && ociStep === 3 && ociSummary && (
          <OciResultStep summary={ociSummary} />
        )}
      </div>
    </MainLayout>
  )
}

// ── 子组件 ──────────────────────────────────────────────

const Stepper: React.FC<{ step: number; titles: string[] }> = ({ step, titles }) => (
  <div className="oci-stepper">
    {titles.map((title, i) => (
      <div key={i} className={`oci-step ${i === step ? 'is-current' : i < step ? 'is-done' : ''}`}>
        <div className="oci-step-node">{i < step ? '✓' : i + 1}</div>
        <div className="oci-step-label">{title}</div>
      </div>
    ))}
  </div>
)

const Row: React.FC<{
  disabled?: boolean
  checked: boolean
  onToggle: () => void
  index: number
  children: React.ReactNode
}> = ({ disabled, checked, onToggle, index, children }) => (
  <label className={`oci-row ${disabled ? 'is-disabled' : ''}`} style={{ animationDelay: `${index * 28}ms` }}>
    <input className="oci-check" type="checkbox" disabled={disabled} checked={checked} onChange={onToggle} />
    {children}
  </label>
)

// ── 上传区（公共）────────────────────────────────────────

const UploadStep: React.FC<{
  file: File | null
  setFile: (f: File | null) => void
  busy: boolean
  onUpload: () => void
}> = ({ file, setFile, busy, onUpload }) => {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="oci-card">
      <div className={`oci-drop ${file ? 'has-file' : ''}`} onClick={() => inputRef.current?.click()}>
        <div className="oci-drop-icon">{file ? '📦' : '⬆'}</div>
        <p className="oci-drop-main">{file ? '已选择备份文件' : '点击选择备份文件'}</p>
        <p className="oci-drop-sub">支持 Crabot 备份 或 OpenClaw 备份（.tar.gz）</p>
        {file && (
          <p className="oci-drop-file">
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
          </p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".gz,.tar,.tgz,application/gzip,application/x-gzip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ display: 'none' }}
        />
      </div>
      <div className="oci-footer">
        <span />
        <button className="btn btn-primary btn-lg" disabled={busy || !file} onClick={onUpload}>
          {busy ? '识别中…' : '上传并识别'}
        </button>
      </div>
    </div>
  )
}

// ── Crabot 分支：类别选择 + 冲突策略 + 执行 ───────────────

const CrabotSelectStep: React.FC<{
  categories: string[]
  selCategories: Set<string>
  onToggleCategory: (k: string) => void
  onConflict: 'skip' | 'overwrite'
  setOnConflict: (v: 'skip' | 'overwrite') => void
  busy: boolean
  onBack: () => void
  onExecute: () => void
}> = ({ categories, selCategories, onToggleCategory, onConflict, setOnConflict, busy, onBack, onExecute }) => (
  <div>
    <section className="oci-card">
      <div className="oci-card-head">
        <h3 className="oci-card-title">选择要导入的类别</h3>
        <span className="oci-count">{selCategories.size} / {categories.length}</span>
      </div>
      {categories.length === 0 && <p className="oci-empty">备份中没有可导入的内容。</p>}
      {categories.map((cat, i) => (
        <Row key={cat} index={i} checked={selCategories.has(cat)} onToggle={() => onToggleCategory(cat)}>
          <span className="oci-row-main">
            <span className="oci-row-name">{categoryLabel(cat)}</span>
          </span>
        </Row>
      ))}
    </section>

    <section className="oci-card">
      <div className="oci-card-head">
        <h3 className="oci-card-title">冲突策略</h3>
      </div>
      <label className="oci-row">
        <input
          className="oci-check"
          type="radio"
          name="on_conflict"
          checked={onConflict === 'skip'}
          onChange={() => setOnConflict('skip')}
        />
        <span className="oci-row-main">
          <span className="oci-row-name">合并（保留已有 id）</span>
          <span className="oci-row-meta" style={{ marginLeft: 0, display: 'block' }}>
            备份中与本地 id 相同的项跳过，不覆盖
          </span>
        </span>
      </label>
      <label className="oci-row">
        <input
          className="oci-check"
          type="radio"
          name="on_conflict"
          checked={onConflict === 'overwrite'}
          onChange={() => setOnConflict('overwrite')}
        />
        <span className="oci-row-main">
          <span className="oci-row-name">覆盖（按 id 替换）</span>
          <span className="oci-row-meta" style={{ marginLeft: 0, display: 'block' }}>
            备份中与本地 id 相同的项，用备份版本覆盖
          </span>
        </span>
      </label>
    </section>

    <div className="oci-footer">
      <button className="btn btn-secondary" onClick={onBack}>
        上一步
      </button>
      <button
        className="btn btn-primary btn-lg"
        disabled={busy || selCategories.size === 0}
        onClick={onExecute}
      >
        {busy ? '导入中…' : '开始导入'}
      </button>
    </div>
  </div>
)

// ── Crabot 分支：结果 ─────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  ok: '成功',
  imported: '成功',
  created: '成功',
  skipped: '已跳过',
  error: '错误',
}

const STATUS_CLASS: Record<string, string> = {
  ok: 'is-ok',
  imported: 'is-ok',
  created: 'is-ok',
  skipped: 'is-skip',
  error: 'is-err',
}

const CrabotResultStep: React.FC<{ summary: CrabotImportSummary; onReset: () => void }> = ({
  summary,
  onReset,
}) => {
  const succeeded = summary.results.filter(
    (r) => r.status === 'ok' || r.status === 'imported' || r.status === 'created',
  )
  const skipped = summary.results.filter((r) => r.status === 'skipped')
  const errored = summary.results.filter((r) => r.status === 'error')

  return (
    <section className="oci-card">
      <div className="oci-result-head">
        <div className="oci-result-badge">✓</div>
        <div>
          <h3 className="oci-card-title">导入完成</h3>
          <p className="oci-subtitle">
            成功 {succeeded.length} 项 · 跳过 {skipped.length} 项
            {errored.length > 0 ? ` · 错误 ${errored.length}` : ''}
            {summary.errors.length > 0 ? ` · 系统错误 ${summary.errors.length}` : ''}
          </p>
        </div>
      </div>

      {summary.results.length > 0 && (
        <table className="oci-result-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>ID</th>
              <th>状态</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {summary.results.map((r, i) => (
              <tr key={i} className={`oci-result-tr ${STATUS_CLASS[r.status] ?? ''}`}>
                <td>
                  <span className="oci-result-kind">{r.kind}</span>
                </td>
                <td className="oci-result-id">{r.id}</td>
                <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                <td className="oci-result-reason">{r.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {summary.errors.length > 0 && (
        <>
          <div className="oci-group-label is-err">系统错误</div>
          {summary.errors.map((e, i) => (
            <div className="oci-result-row" key={i} style={{ color: 'var(--error)' }}>
              {e}
            </div>
          ))}
        </>
      )}

      <div className="oci-footer">
        <span />
        <button className="btn btn-secondary" onClick={onReset}>
          重新导入
        </button>
      </div>
    </section>
  )
}

// ── OpenClaw 分支子组件（原有，保持不变）───────────────────

const ConfigStep: React.FC<{
  overview: BackupOverview
  selProviders: Set<string>
  selChannels: Set<string>
  onToggleProvider: (k: string) => void
  onToggleChannel: (k: string) => void
  channelKey: (c: { source_channel: string; account_id?: string }) => string
  onBack: () => void
  onNext: () => void
}> = ({ overview, selProviders, selChannels, onToggleProvider, onToggleChannel, channelKey, onBack, onNext }) => (
  <div>
    <section className="oci-card">
      <div className="oci-card-head">
        <h3 className="oci-card-title">Provider</h3>
        <span className="oci-count">{overview.providers.length}</span>
      </div>
      {overview.providers.length === 0 && <p className="oci-empty">备份中没有 provider。</p>}
      {overview.providers.map((p, i) => (
        <Row
          key={p.source_name}
          index={i}
          disabled={!p.migratable}
          checked={selProviders.has(p.source_name)}
          onToggle={() => onToggleProvider(p.source_name)}
        >
          <span className="oci-row-main">
            <span className="oci-row-name">{p.source_name}</span>
            <span className="oci-row-meta">
              {p.format ?? '—'} · {p.endpoint}
            </span>
          </span>
          {!p.migratable && p.skip_reason && (
            <span className="oci-tag">{PROVIDER_SKIP_LABEL[p.skip_reason]}</span>
          )}
        </Row>
      ))}
    </section>

    <section className="oci-card">
      <div className="oci-card-head">
        <h3 className="oci-card-title">Channel</h3>
        <span className="oci-count">{overview.channels.length}</span>
      </div>
      <p className="oci-hint">仅 Telegram / 飞书 / Lark 可迁移，其余 channel crabot 暂无对应模块。</p>
      {overview.channels.length === 0 && <p className="oci-empty">备份中没有可识别的 channel。</p>}
      {overview.channels.map((c, i) => {
        const key = channelKey(c)
        const selectable = c.migratable && c.credentials === 'available'
        return (
          <Row
            key={key}
            index={i}
            disabled={!selectable}
            checked={selChannels.has(key)}
            onToggle={() => onToggleChannel(key)}
          >
            <span className="oci-row-main">
              <span className="oci-row-name">{c.source_channel}</span>
              {c.account_id && (
                <span className="oci-row-meta">
                  {c.account_id}
                  {c.feishu_domain ? ` · ${c.feishu_domain}` : ''}
                </span>
              )}
            </span>
            {!c.migratable && (
              <span className="oci-tag oci-tag--muted">
                {c.skip_reason === 'invalid-name' ? '实例名不合法' : '无对应模块'}
              </span>
            )}
            {c.migratable && c.credentials === 'unavailable' && (
              <span className="oci-tag">密钥不在备份，需手填</span>
            )}
          </Row>
        )
      })}
    </section>

    <div className="oci-footer">
      <button className="btn btn-secondary" onClick={onBack}>
        上一步
      </button>
      <button className="btn btn-primary" onClick={onNext}>
        下一步
      </button>
    </div>
  </div>
)

const ContentStep: React.FC<{
  overview: BackupOverview
  selMcp: Set<string>
  selSkills: Set<string>
  importMemory: boolean
  importWorkspace: boolean
  onToggleMcp: (k: string) => void
  onToggleSkill: (k: string) => void
  setImportMemory: (v: boolean) => void
  setImportWorkspace: (v: boolean) => void
  onBack: () => void
  onNext: () => void
}> = ({
  overview,
  selMcp,
  selSkills,
  importMemory,
  importWorkspace,
  onToggleMcp,
  onToggleSkill,
  setImportMemory,
  setImportWorkspace,
  onBack,
  onNext,
}) => {
  const noWs = !overview.manifest.includeWorkspace
  return (
    <div>
      <section className="oci-card">
        <div className="oci-card-head">
          <h3 className="oci-card-title">Skills</h3>
          <span className="oci-count">{overview.skills.length}</span>
        </div>
        {overview.skills.length === 0 && <p className="oci-empty">备份中没有 skill。</p>}
        {overview.skills.map((s, i) => (
          <Row key={s} index={i} checked={selSkills.has(s)} onToggle={() => onToggleSkill(s)}>
            <span className="oci-row-main">
              <span className="oci-row-name">{s}</span>
            </span>
          </Row>
        ))}
      </section>

      <section className="oci-card">
        <div className="oci-card-head">
          <h3 className="oci-card-title">MCP Servers</h3>
          <span className="oci-count">{overview.mcpServers.length}</span>
        </div>
        {overview.mcpServers.length === 0 && <p className="oci-empty">备份中没有 MCP server。</p>}
        {overview.mcpServers.map((m, i) => (
          <Row
            key={m.source_name}
            index={i}
            disabled={!m.migratable}
            checked={selMcp.has(m.source_name)}
            onToggle={() => onToggleMcp(m.source_name)}
          >
            <span className="oci-row-main">
              <span className="oci-row-name">{m.name}</span>
              <span className="oci-row-meta">{m.transport}</span>
            </span>
            {m.requires_local_env && <span className="oci-tag">依赖本机环境</span>}
          </Row>
        ))}
      </section>

      <section className="oci-card">
        <div className="oci-card-head">
          <h3 className="oci-card-title">记忆与工作区</h3>
        </div>
        {noWs && (
          <p className="oci-hint" style={{ color: 'var(--warning-text)' }}>
            此备份未包含 workspace，记忆与工作区文件均缺失。请用完整备份（不带 --no-include-workspace）重新导出。
          </p>
        )}
        <Row
          index={0}
          disabled={noWs || !overview.memory.present}
          checked={importMemory}
          onToggle={() => setImportMemory(!importMemory)}
        >
          <span className="oci-row-main">
            <span className="oci-row-name">导入记忆</span>
            <span className="oci-row-meta">{overview.memory.fileCount} 个文件 → Memory v2</span>
          </span>
        </Row>
        <Row
          index={1}
          disabled={noWs || !overview.workspace.present}
          checked={importWorkspace}
          onToggle={() => setImportWorkspace(!importWorkspace)}
        >
          <span className="oci-row-main">
            <span className="oci-row-name">导入工作区文件</span>
            <span className="oci-row-meta">{overview.workspace.fileCount} 个文件</span>
          </span>
        </Row>
      </section>

      <div className="oci-footer">
        <button className="btn btn-secondary" onClick={onBack}>
          上一步
        </button>
        <button className="btn btn-primary" onClick={onNext}>
          下一步
        </button>
      </div>
    </div>
  )
}

const PreviewStep: React.FC<{
  selections: ImportSelections
  busy: boolean
  onBack: () => void
  onExecute: () => void
}> = ({ selections, busy, onBack, onExecute }) => (
  <div>
    <section className="oci-card">
      <div className="oci-card-head">
        <h3 className="oci-card-title">即将导入</h3>
      </div>
      <ul className="oci-stats">
        <li>
          <span>Provider</span>
          <b>{selections.providers.length}</b>
        </li>
        <li>
          <span>Channel</span>
          <b>{selections.channels.length}</b>
        </li>
        <li>
          <span>MCP</span>
          <b>{selections.mcp.length}</b>
        </li>
        <li>
          <span>Skills</span>
          <b>{selections.skills.length}</b>
        </li>
        <li>
          <span>记忆</span>
          <b>{selections.memory ? '是' : '否'}</b>
        </li>
        <li>
          <span>工作区文件</span>
          <b>{selections.workspace ? '是' : '否'}</b>
        </li>
      </ul>
      <p className="oci-hint" style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>
        冲突项（crabot 已存在同名）将自动跳过。
      </p>
    </section>
    <div className="oci-footer">
      <button className="btn btn-secondary" onClick={onBack}>
        上一步
      </button>
      <button className="btn btn-primary btn-lg" disabled={busy} onClick={onExecute}>
        {busy ? '导入中…' : '执行导入'}
      </button>
    </div>
  </div>
)

const OciResultStep: React.FC<{ summary: OciImportSummary }> = ({ summary }) => {
  const imported = summary.results.filter((r) => r.status === 'imported')
  const skipped = summary.results.filter((r) => r.status === 'skipped')
  return (
    <section className="oci-card">
      <div className="oci-result-head">
        <div className="oci-result-badge">✓</div>
        <div>
          <h3 className="oci-card-title">导入完成</h3>
          <p className="oci-subtitle">
            成功 {imported.length} 项 · 跳过 {skipped.length} 项
            {summary.errors.length ? ` · 错误 ${summary.errors.length}` : ''}
          </p>
        </div>
      </div>

      {imported.length > 0 && (
        <>
          <div className="oci-group-label is-ok">已导入</div>
          {imported.map((r, i) => (
            <div className="oci-result-row" key={i}>
              <span className="oci-result-kind">{r.kind}</span>
              {r.name}
            </div>
          ))}
        </>
      )}

      {skipped.length > 0 && (
        <>
          <div className="oci-group-label is-skip">已跳过</div>
          {skipped.map((r, i) => (
            <div className="oci-result-row" key={i}>
              <span className="oci-result-kind">{r.kind}</span>
              {r.name} — {r.reason ? SKIP_REASON_LABEL[r.reason] : '已跳过'}
            </div>
          ))}
        </>
      )}

      {summary.errors.length > 0 && (
        <>
          <div className="oci-group-label is-err">错误</div>
          {summary.errors.map((e, i) => (
            <div className="oci-result-row" key={i} style={{ color: 'var(--error)' }}>
              {e}
            </div>
          ))}
        </>
      )}
    </section>
  )
}
