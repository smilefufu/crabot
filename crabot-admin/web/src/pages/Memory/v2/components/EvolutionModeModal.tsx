import React, { useState } from 'react'
import type { EvolutionMode } from '../../../../services/memoryV2'

const MODES: Array<{ value: EvolutionMode; label: string; tooltip: string }> = [
  { value: 'balanced', label: '平衡', tooltip: '默认：50% 新知识 / 30% 优化已有 / 20% 修复矛盾' },
  { value: 'innovate', label: '偏创新', tooltip: '80% 新知识抽取，少量验证（系统稳定时用）' },
  { value: 'harden', label: '偏稳固', tooltip: '重点优化已有（大量新知识刚摄入后用）' },
  { value: 'repair-only', label: '仅修复', tooltip: '集中清理矛盾、纠正错误（错误率高时用）' },
]

export interface EvolutionModeModalProps {
  open: boolean
  current: EvolutionMode
  onClose: () => void
  onSubmit: (mode: EvolutionMode, reason: string) => Promise<void>
}

export const EvolutionModeModal: React.FC<EvolutionModeModalProps> = ({ open, current, onClose, onSubmit }) => {
  const [mode, setMode] = useState<EvolutionMode>(current)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  if (!open) return null

  async function save() {
    setBusy(true); setErr('')
    try {
      await onSubmit(mode, reason)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mem-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="mem-modal" role="dialog" aria-modal="true">
        <h3 className="mem-modal__title">演化模式</h3>
        <div className="mem-evo-modal__list">
          {MODES.map(m => (
            <label key={m.value} className={`mem-evo-modal__option${mode === m.value ? ' mem-evo-modal__option--active' : ''}`}>
              <input
                type="radio"
                aria-label={m.label}
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
                className="mem-evo-modal__radio"
              />
              <div className="mem-evo-modal__option-body">
                <div className="mem-evo-modal__option-label">{m.label}</div>
                <div className="mem-evo-modal__option-hint">{m.tooltip}</div>
              </div>
            </label>
          ))}
        </div>
        <label className="mem-modal__field">
          <span className="mem-modal__field-label">切换原因（用于审计）</span>
          <input
            aria-label="切换原因"
            value={reason}
            onChange={e => setReason(e.target.value)}
            className="mem-modal__input"
            placeholder="例如：最近错误率升高，集中修复矛盾"
          />
        </label>
        {err && <div className="mem-modal__error">{err}</div>}
        <div className="mem-modal__actions">
          <button type="button" className="mem-modal__btn" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="mem-modal__btn mem-modal__btn--primary" onClick={save} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
