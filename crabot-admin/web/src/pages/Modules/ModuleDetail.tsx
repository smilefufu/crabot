import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { legacyArchiveService, type LegacyAgentArchiveSummary, type DeleteLegacyAgentArchiveResult } from '../../services/legacy-archive'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'

/**
 * P6-D：Module detail 退役为两种形态——
 * - `crabot-agent`：唯一 live core Agent 静态身份（引导去 /agents/config）。
 * - `legacy:<archive_id>`：unsupported legacy archive 只读摘要 + 显式导出/卸载（§3.18）。
 * 不再渲染 legacy model_roles 为「当前能力」。
 */
export function ModuleDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [archive, setArchive] = useState<LegacyAgentArchiveSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletePkg, setDeletePkg] = useState(false)
  const [deleteCfg, setDeleteCfg] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DeleteLegacyAgentArchiveResult | null>(null)

  const archiveId = id?.startsWith('legacy:') ? id.slice('legacy:'.length) : null

  const load = useCallback(async () => {
    if (!archiveId) { setLoading(false); return }
    try {
      setLoading(true)
      const items = await legacyArchiveService.list()
      setArchive(items.find((item) => item.archive_id === archiveId) ?? null)
      if (!items.some((item) => item.archive_id === archiveId)) setError('archive 不存在或已移除')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [archiveId])

  useEffect(() => { void load() }, [load])

  if (id === 'crabot-agent') {
    return (
      <MainLayout>
        <div style={{ marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>Crabot Core Agent</h1>
          <span className="badge badge-primary">内置</span>
        </div>
        <Card title="唯一 live Agent">
          <p>core Agent 是 release 内置的唯一 Agent。行为与模型配置请前往「Agents → 配置」。</p>
          <Button onClick={() => navigate('/agents/config')}>打开配置</Button>
        </Card>
      </MainLayout>
    )
  }

  if (loading) return <MainLayout><Loading /></MainLayout>
  if (!archive) return <MainLayout><div className="error-message">{error || '模块不存在'}</div></MainLayout>

  const doExport = async () => {
    const record = await legacyArchiveService.export(archive.archive_id)
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${archive.archive_id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const doDelete = async () => {
    if (!deletePkg && !deleteCfg) return
    if (confirmText !== archive.archive_id) return
    setBusy(true)
    try {
      const r = await legacyArchiveService.remove(archive.archive_id, { delete_package: deletePkg, delete_config: deleteCfg })
      setResult(r)
      if (r.archive_removed) navigate('/modules')
      else await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>{archive.display_name ?? archive.archive_id}</h1>
          <span className="badge badge-warning">不受支持的 legacy archive</span>
        </div>
        <Button variant="secondary" onClick={() => navigate('/modules')}>返回</Button>
      </div>

      {error && <div className="error-message">{error}</div>}
      {result && (
        <div className="info-message">
          已删除: {result.deleted_resources.join(', ') || '无'}
          {result.retained_resources.length > 0 && `；保留: ${result.retained_resources.join(', ')}`}
        </div>
      )}

      <div style={{ display: 'grid', gap: '1.5rem' }}>
        <Card title="Archive 信息">
          <table className="table">
            <tbody>
              <tr><td style={{ width: '150px', color: 'var(--text-secondary)' }}>archive_id</td><td><code>{archive.archive_id}</code></td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>来源类型</td><td>{archive.source_kind}</td></tr>
              {archive.module_id && <tr><td style={{ color: 'var(--text-secondary)' }}>module_id</td><td>{archive.module_id}</td></tr>}
              <tr><td style={{ color: 'var(--text-secondary)' }}>归档时间</td><td>{new Date(archive.archived_at).toLocaleString()}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>支持状态</td><td>unsupported_legacy（不会执行，仅审计/导出/显式删除）</td></tr>
            </tbody>
          </table>
        </Card>

        <Card title="导出">
          <p style={{ color: 'var(--text-secondary)' }}>导出经认证的脱敏 JSON（不含运行凭据）。</p>
          <Button onClick={() => void doExport()}>导出 archive</Button>
        </Card>

        {archive.uninstallable ? (
          <Card title="删除（危险操作）">
            <p style={{ color: 'var(--text-secondary)' }}>
              至少选择一项。删除写入 tombstone，同选择重试返回相同结果。core/builtin 不可删除。
            </p>
            <label style={{ display: 'block', margin: '0.5rem 0' }}>
              <input type="checkbox" checked={deletePkg} onChange={(e) => setDeletePkg(e.target.checked)} /> 删除 package
            </label>
            <label style={{ display: 'block', margin: '0.5rem 0' }}>
              <input type="checkbox" checked={deleteCfg} onChange={(e) => setDeleteCfg(e.target.checked)} /> 删除 config
            </label>
            <label style={{ display: 'block', margin: '0.5rem 0' }}>
              输入 <code>{archive.archive_id}</code> 确认：
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} style={{ marginLeft: '0.5rem' }} />
            </label>
            <Button
              variant="danger"
              disabled={busy || (!deletePkg && !deleteCfg) || confirmText !== archive.archive_id}
              onClick={() => void doDelete()}
            >
              确认删除
            </Button>
          </Card>
        ) : (
          <Card title="删除">
            <p style={{ color: 'var(--text-secondary)' }}>该 archive 不可卸载（core 保护或无可删除资源）。</p>
          </Card>
        )}
      </div>
    </MainLayout>
  )
}
