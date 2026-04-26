import React from 'react'

export interface BatchActionBarProps {
  count: number
  onBatchDelete: () => void | Promise<void>
  onBatchEditTags: () => void
  onClear: () => void
}

export const BatchActionBar: React.FC<BatchActionBarProps> = ({
  count, onBatchDelete, onBatchEditTags, onClear,
}) => {
  if (count <= 0) return null
  return (
    <div className="mem-batch-bar">
      <span className="mem-batch-bar__count">已选 <b>{count}</b> 条</span>
      <button
        type="button"
        className="mem-batch-bar__btn mem-batch-bar__btn--danger"
        onClick={() => void onBatchDelete()}
      >
        批量删除
      </button>
      <button type="button" className="mem-batch-bar__btn" onClick={onBatchEditTags}>
        批量编辑标签
      </button>
      <span className="mem-batch-bar__spacer" />
      <button type="button" className="mem-batch-bar__clear" onClick={onClear}>取消选择</button>
    </div>
  )
}
