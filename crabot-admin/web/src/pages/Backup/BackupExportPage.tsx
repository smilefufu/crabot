/**
 * 备份导出页面。
 *
 * 选择要导出的类别，可选是否导出密钥，触发 tar.gz 下载。
 * 视觉对齐 Admin 设计系统（仿 OpenClawImportWizard 风格）。
 */
import React, { useEffect, useState } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { useToast } from '../../contexts/ToastContext'
import { fetchBackupOptions, downloadBackup } from '../../services/backup'
import './BackupExportPage.css'

const CATEGORY_LABELS: Record<string, string> = {
  config: '配置（模型/Agent/模板/MCP）',
  channels: '聊天方式与朋友（含权限）',
  skills: '技能',
  memory: '长期记忆',
  tasks: '任务与日程',
}

export const BackupExportPage: React.FC = () => {
  const toast = useToast()
  const [all, setAll] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchBackupOptions()
      .then((o) => {
        setAll(o.categories)
        setSelected(new Set(o.defaults))
      })
      .catch(() => {
        toast.error('获取备份选项失败')
        setAll([])
      })
      .finally(() => setLoading(false))
  }, [toast])

  function toggle(cat: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) {
        next.delete(cat)
      } else {
        next.add(cat)
      }
      return next
    })
  }

  async function handleExport() {
    if (selected.size === 0) return
    setBusy(true)
    try {
      await downloadBackup([...selected], includeSecrets)
      toast.success('备份已开始下载')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导出失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <MainLayout>
      <div className="bx-wrap">
        <header className="bx-head">
          <div className="bx-head-mark">📦</div>
          <div>
            <h1 className="bx-title">导出备份</h1>
            <p className="bx-subtitle">选择要导出的类别，打包为可在另一台 CRABOT 上导入的归档文件（.tar.gz）。</p>
          </div>
        </header>

        <section className="bx-card">
          <div className="bx-card-head">
            <h3 className="bx-card-title">导出类别</h3>
          </div>

          {loading && <p className="bx-hint">加载中…</p>}

          {!loading && all.length === 0 && (
            <p className="bx-empty">暂无可导出的类别。</p>
          )}

          {all.map((cat, i) => (
            <label
              key={cat}
              className="bx-row"
              style={{ animationDelay: `${i * 28}ms` }}
            >
              <input
                className="bx-check"
                type="checkbox"
                checked={selected.has(cat)}
                onChange={() => toggle(cat)}
              />
              <span className="bx-row-main">
                <span className="bx-row-name">{CATEGORY_LABELS[cat] ?? cat}</span>
              </span>
            </label>
          ))}
        </section>

        <section className="bx-card">
          <div className="bx-card-head">
            <h3 className="bx-card-title">密钥选项</h3>
          </div>
          <label className="bx-row">
            <input
              className="bx-check"
              type="checkbox"
              checked={includeSecrets}
              onChange={(e) => setIncludeSecrets(e.target.checked)}
            />
            <span className="bx-row-main">
              <span className="bx-row-name">导出密钥（API Key / OAuth 凭证 / 登录口令）</span>
              <span className="bx-row-meta">默认不含密钥，导入后需重新填写</span>
            </span>
          </label>
          {includeSecrets && (
            <div className="bx-warning">
              ⚠️ 归档将含明文密钥。任何拿到此文件的人都能直接使用你的账号与模型额度，请务必妥善保管、不要随意分享或上传。
            </div>
          )}
        </section>

        <div className="bx-footer">
          <button
            className="btn btn-primary btn-lg"
            disabled={selected.size === 0 || busy}
            onClick={handleExport}
          >
            {busy ? '导出中…' : '导出并下载'}
          </button>
        </div>
      </div>
    </MainLayout>
  )
}
