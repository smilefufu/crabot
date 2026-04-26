import React from 'react'

export type SearchMode = 'keyword' | 'semantic'

export interface SearchBoxProps {
  value: string
  mode: SearchMode
  onChange: (v: string) => void
  onModeChange: (m: SearchMode) => void
}

export const SearchBox: React.FC<SearchBoxProps> = ({ value, mode, onChange, onModeChange }) => (
  <div className="mem-search">
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="🔍 搜索 摘要 / 正文 ..."
      className="mem-search__input"
    />
    <div className="mem-search-toggle">
      <button
        type="button"
        aria-pressed={mode === 'keyword'}
        onClick={() => onModeChange('keyword')}
        className={'mem-search-toggle__btn' + (mode === 'keyword' ? ' mem-search-toggle__btn--active' : '')}
      >
        关键字
      </button>
      <button
        type="button"
        aria-pressed={mode === 'semantic'}
        onClick={() => onModeChange('semantic')}
        className={'mem-search-toggle__btn' + (mode === 'semantic' ? ' mem-search-toggle__btn--active' : '')}
      >
        🤖 语义相关
      </button>
    </div>
  </div>
)
