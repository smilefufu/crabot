import React, { useState } from 'react'
import type { CreateEntryParams, MemoryEntryV2, MemoryType } from '../../../../services/memoryV2'

const TYPE_LABEL: Record<MemoryType, string> = {
  fact: '事实',
  lesson: '经验',
  concept: '概念',
}

export type MemoryFormMode =
  | { kind: 'create'; defaultType?: MemoryType }
  | { kind: 'edit'; entry: MemoryEntryV2 }

export interface MemoryEntryFormProps {
  mode: MemoryFormMode
  onCancel: () => void
  onSubmitCreate?: (payload: CreateEntryParams) => Promise<void>
  onSubmitEdit?: (id: string, patch: { brief?: string; body?: string; tags?: string[] }) => Promise<void>
}

export const MemoryEntryForm: React.FC<MemoryEntryFormProps> = ({
  mode, onCancel, onSubmitCreate, onSubmitEdit,
}) => {
  const isEdit = mode.kind === 'edit'
  const entry = isEdit ? mode.entry : null

  const [type, setType] = useState<MemoryType>(
    isEdit ? entry!.frontmatter!.type : (mode.kind === 'create' ? (mode.defaultType ?? 'fact') : 'fact'),
  )
  const [brief, setBrief] = useState(entry?.brief ?? '')
  const [body, setBody] = useState(entry?.body ?? '')
  const [tagsInput, setTagsInput] = useState(
    entry ? (entry.frontmatter?.tags ?? []).join(', ') : '',
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    setBusy(true); setErr('')
    try {
      if (isEdit) {
        await onSubmitEdit?.(entry!.id, {
          brief,
          body,
          tags: tagsInput.split(',').map(s => s.trim()).filter(Boolean),
        })
      } else {
        await onSubmitCreate?.({
          type,
          brief,
          content: body,
          source_ref: { type: 'manual' },
          source_trust: 5,
          content_confidence: 5,
          importance_factors: { proximity: 0.5, surprisal: 0.5, entity_priority: 0.5, unambiguity: 0.5 },
          entities: [],
          tags: tagsInput.split(',').map(s => s.trim()).filter(Boolean),
          event_time: new Date().toISOString(),
        })
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
      return
    }
    setBusy(false)
    onCancel()
  }

  return (
    <form className="mem-form" onSubmit={e => { e.preventDefault(); void save() }}>
      <div className="mem-form__body">
        {!isEdit && (
          <label className="mem-form__field">
            <span className="mem-form__label">类型</span>
            <select
              aria-label="类型"
              value={type}
              onChange={e => setType(e.target.value as MemoryType)}
              className="mem-form__select"
            >
              {(['fact', 'lesson', 'concept'] as MemoryType[]).map(t => (
                <option key={t} value={t}>{TYPE_LABEL[t]}</option>
              ))}
            </select>
          </label>
        )}

        <label className="mem-form__field">
          <span className="mem-form__label">摘要</span>
          <input
            aria-label="摘要"
            value={brief}
            onChange={e => setBrief(e.target.value)}
            maxLength={80}
            className="mem-form__input"
            placeholder="简短描述这条记忆…"
            autoFocus
          />
          <span className="mem-form__hint">{brief.length} / 80</span>
        </label>

        <label className="mem-form__field mem-form__field--grow">
          <span className="mem-form__label">正文（支持 Markdown）</span>
          <textarea
            aria-label="正文"
            value={body}
            onChange={e => setBody(e.target.value)}
            className="mem-form__textarea"
            placeholder="写下完整内容…"
          />
        </label>

        <label className="mem-form__field">
          <span className="mem-form__label">标签（逗号分隔）</span>
          <input
            aria-label="标签"
            value={tagsInput}
            onChange={e => setTagsInput(e.target.value)}
            className="mem-form__input"
            placeholder="例如：产品, 架构, 决策"
          />
        </label>

        {err && <div className="mem-form__error">{err}</div>}
      </div>

      <div className="mem-form__footer">
        <button type="button" className="mem-form__btn" onClick={onCancel} disabled={busy}>取消</button>
        <button
          type="submit"
          className="mem-form__btn mem-form__btn--primary"
          disabled={busy || !brief.trim() || !body.trim()}
        >
          {busy ? '保存中…' : (isEdit ? '保存修改' : '创建记忆')}
        </button>
      </div>
    </form>
  )
}
