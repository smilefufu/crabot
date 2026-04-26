import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router-dom'
import type { MemoryEntryV2 } from '../../../../services/memoryV2'
import { AuthorBadge } from './AuthorBadge'

const SOURCE_TYPE_LABEL: Record<string, string> = {
  conversation: '对话',
  reflection: '反思',
  manual: '手工录入',
  system: '系统',
}

const MATURITY_LABEL: Record<string, string> = {
  observed: '初见', confirmed: '已确认', stale: '已过期',
  case: '单次', rule: '通用经验', retired: '已退休',
  draft: '草稿', established: '已建立',
}

const TYPE_LABEL: Record<string, string> = {
  fact: '事实', lesson: '经验', concept: '概念',
}

export interface EntryDetailPanelProps {
  entry: MemoryEntryV2 | null
  onEdit: (e: MemoryEntryV2) => void
  onDelete: (e: MemoryEntryV2) => void
  onRestore?: (e: MemoryEntryV2) => void
  onPurge?: (e: MemoryEntryV2) => void
  onCompareVersion?: (prevVersionId: string) => void
}

export const EntryDetailPanel: React.FC<EntryDetailPanelProps> = ({
  entry, onEdit, onDelete, onRestore, onPurge, onCompareVersion,
}) => {
  if (!entry) return <div className="mem-detail__placeholder">选择记忆查看详情</div>

  const fm = entry.frontmatter
  const isTrash = entry.status === 'trash'

  const actions = isTrash ? (
    <div className="mem-detail__actions">
      <button type="button" className="mem-detail__btn mem-detail__btn--primary" onClick={() => onRestore?.(entry)}>恢复</button>
      <button type="button" className="mem-detail__btn mem-detail__btn--danger" onClick={() => onPurge?.(entry)}>永久删除</button>
    </div>
  ) : (
    <div className="mem-detail__actions">
      <button type="button" className="mem-detail__btn" onClick={() => onEdit(entry)}>编辑</button>
      <button type="button" className="mem-detail__btn mem-detail__btn--danger" onClick={() => onDelete(entry)}>删除</button>
    </div>
  )

  return (
    <div className="mem-detail">
      <div className="mem-detail__header">
        <div>
          <h2 className="mem-detail__title">{entry.brief}</h2>
          {fm && (
            <div className="mem-detail__meta">
              <span>{TYPE_LABEL[fm.type] ?? fm.type}</span>
              <span className="mem-detail__meta-sep" aria-hidden="true">·</span>
              <span>{MATURITY_LABEL[fm.maturity] ?? fm.maturity}</span>
              <span className="mem-detail__meta-sep" aria-hidden="true">·</span>
              <AuthorBadge author={fm.author} />
            </div>
          )}
        </div>
        {actions}
      </div>

      {fm?.invalidated_by && (
        <div className="mem-detail__banner mem-detail__banner--warn">
          此记忆已被 <Link to={`/memory/long-term?focus=${encodeURIComponent(fm.invalidated_by)}`}>{fm.invalidated_by}</Link> 替代
        </div>
      )}

      {isTrash && fm && (
        <div className="mem-detail__banner mem-detail__banner--info">
          此记忆已删除，30 天后（按入库时间 {fm.ingestion_time} 起）自动清除
        </div>
      )}

      {fm && (
        <>
          <section className="mem-detail__section">
            <h3 className="mem-detail__section-head">身份</h3>
            <div className="mem-detail__kv">
              <div>ID：<span className="mono">{fm.id}</span></div>
              <div>实体：{fm.entities.map(e => `${e.name}（${e.type}）`).join('、') || '—'}</div>
              <div>标签：{fm.tags.join(' ') || '—'}</div>
            </div>
          </section>

          <section className="mem-detail__section">
            <h3 className="mem-detail__section-head">来源</h3>
            <div className="mem-detail__kv">
              <div>类型：{SOURCE_TYPE_LABEL[fm.source_ref.type] ?? fm.source_ref.type}</div>
              {fm.source_ref.task_id && <div>任务：<span className="mono">{fm.source_ref.task_id}</span></div>}
              {fm.source_ref.session_id && <div>会话：<span className="mono">{fm.source_ref.session_id}</span></div>}
              {fm.source_ref.channel_id && <div>频道：<span className="mono">{fm.source_ref.channel_id}</span></div>}
              {fm.source_ref.trace_id && (
                <div>
                  轨迹：<Link to={`/traces/${fm.source_ref.trace_id}`} className="mem-detail__trace-link">{fm.source_ref.trace_id}</Link>
                </div>
              )}
            </div>
          </section>

          <section className="mem-detail__section">
            <h3 className="mem-detail__section-head">可信度</h3>
            <div className="mem-detail__kv">
              <div>信任等级：<b>{fm.source_trust}</b>/5　　内容置信：<b>{fm.content_confidence}</b>/5</div>
              <div className="mem-detail__kv-sub">
                重要性：近度 {fm.importance_factors.proximity.toFixed(1)} · 意外 {fm.importance_factors.surprisal.toFixed(1)} · 实体 {fm.importance_factors.entity_priority.toFixed(1)} · 清晰 {fm.importance_factors.unambiguity.toFixed(1)}
              </div>
            </div>
          </section>

          <section className="mem-detail__section">
            <h3 className="mem-detail__section-head">时间线</h3>
            <div className="mem-detail__kv">
              <div>事件时间：{fm.event_time}</div>
              <div>入库时间：{fm.ingestion_time}</div>
              {fm.observation && (
                <div>观察期：{fm.observation.validation_outcome === 'pass' ? '已通过' : fm.observation.validation_outcome === 'fail' ? '未通过' : `进行中（${fm.observation.observation_window_days ?? 7} 天）`}</div>
              )}
            </div>
          </section>

          <section className="mem-detail__section">
            <h3 className="mem-detail__section-head">版本历史</h3>
            <div className="mem-detail__kv">
              <div className="mem-detail__version mem-detail__version--current">
                <span aria-hidden="true">●</span>
                <span>v{fm.version}（当前）</span>
              </div>
              {(fm.prev_version_ids ?? []).map((pid, i) => (
                <div key={pid} className="mem-detail__version">
                  <span aria-hidden="true">○</span>
                  <span>v{fm.version - 1 - i}</span>
                  <button
                    type="button"
                    className="mem-detail__version-compare"
                    onClick={() => onCompareVersion?.(pid)}
                  >
                    对比
                  </button>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="mem-detail__section">
        <h3 className="mem-detail__section-head">正文</h3>
        <div className="mem-detail__body">
          {entry.body
            ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.body}</ReactMarkdown>
            : <div className="mem-detail__body--empty">（无正文）</div>}
        </div>
      </section>
    </div>
  )
}
