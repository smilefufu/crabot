import type { StoragePermission } from '../types'

export function StoragePermissionEditor({ value, onChange, disabled = false }: {
  value: StoragePermission | null
  onChange: (value: StoragePermission | null) => void
  disabled?: boolean
}) {
  const all = !!value && 'scope' in value
  return <div style={{ display: 'grid', gap: '0.5rem' }}>
    <label><input aria-label="授权额外目录" type="checkbox" checked={!!value} disabled={disabled}
      onChange={event => onChange(event.target.checked ? { workspace_path: '', access: 'read' } : null)} />授权额外目录</label>
    {!value && <small><span>未授权额外目录</span>；仅受管默认工作区：开启文件操作时，可访问当前任务自有默认目录。</small>}
    {value && <>
      <label>目录授权模式<select className="select" value={all ? 'all' : 'directory'} disabled={disabled}
        onChange={event => onChange(event.target.value === 'all' ? { scope: 'all', access: value.access } : { workspace_path: '', access: value.access })}>
        <option value="directory">指定目录</option><option value="all">允许所有目录</option>
      </select></label>
      {'workspace_path' in value && <label>额外目录路径<input aria-label="额外目录路径" className="input" value={value.workspace_path} disabled={disabled}
        onChange={event => onChange({ workspace_path: event.target.value, access: value.access })} /></label>}
      <label>访问级别<select aria-label="访问级别" className="select" value={value.access} disabled={disabled}
        onChange={event => onChange({ ...value, access: event.target.value as 'read' | 'readwrite' })}>
        <option value="read">只读</option><option value="readwrite">读写</option>
      </select></label>
      {all && <small>允许当前系统账号可访问的所有目录；文件和 Shell 等入口开关仍分别生效。</small>}
    </>}
  </div>
}
