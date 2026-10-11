import { useEffect, useState } from 'react'
import { Button } from '../../components/Common/Button'
import { sessionService, type GroupSessionPermissionConfig } from '../../services/session'
import { permissionTemplateService } from '../../services/permission-template'
import { TOOL_CATEGORY_LABELS, VISIBLE_TOOL_CATEGORIES, type PermissionTemplate } from '../../types'
import { buildGroupPermissionOverrides, resolveGroupPermissions } from '../DialogObjects/group-permission-utils'
import { CliAccessEditor } from '../DialogObjects/components/CliAccessEditor'

type Permissions = ReturnType<typeof resolveGroupPermissions>
export function VoiceGroupConfig({ channelId, onDirty }: { channelId: string; onDirty?: (dirty: boolean) => void }) {
  const [savedForm, setSavedForm] = useState('')
  const [sessionId, setSessionId] = useState(''), [templates, setTemplates] = useState<PermissionTemplate[]>([])
  const [template, setTemplate] = useState<PermissionTemplate>(), [previous, setPrevious] = useState<GroupSessionPermissionConfig | null>(null)
  const [value, setValue] = useState<Permissions>(), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void sessionService.listSessions(channelId, 'group').then(async result => {
      const group = result.items.find(s => s.platform_session_id === 'household'); if (!group) throw new Error('语音群尚未就绪')
      const [{ config }, list] = await Promise.all([sessionService.getGroupConfig(channelId, group.id), permissionTemplateService.list({ page_size: 100 })])
      const selected = list.items.find(t => t.id === (config?.template_id ?? 'group_default')) ?? (await permissionTemplateService.get(config?.template_id ?? 'group_default')).template
      if (!active) return
      const resolved = resolveGroupPermissions(group.id, selected, config)
      setSessionId(group.id); setTemplates(list.items); setTemplate(selected); setPrevious(config); setValue(resolved); setSavedForm(JSON.stringify({ template: selected.id, value: resolved })); setError('')
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [channelId])
  const dirty = !!value && !!template && savedForm !== JSON.stringify({ template: template.id, value })
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty, onDirty])
  async function save() {
    if (!template || !value) return
    setBusy(true); setError(''); setNotice('')
    try {
      if (value.storage && !value.storage.workspace_path.trim()) throw new Error('存储路径不能为空')
      if (!value.memory_scopes.length || value.memory_scopes.some(s => !s.trim())) throw new Error('请至少填写一个记忆范围')
      const result = await sessionService.updateGroupConfig(channelId, sessionId, buildGroupPermissionOverrides(sessionId, template, value, previous))
      setPrevious(result.config); setSavedForm(JSON.stringify({ template: template.id, value })); setNotice('群权限已保存')
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败') } finally { setBusy(false) }
  }
  return <div><h4>语音群权限</h4><p>所有发言者共用一个语音群的权限，包括陌生人。群成员名册中的 Master 按现有群聊规则检查；无需本人正在说话，也无需先登记声纹。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {value && template && <>
      <label>群权限模板<select className="select" value={template.id} disabled={busy} onChange={e => { const next = templates.find(t => t.id === e.target.value); if (next) { setTemplate(next); setValue(resolveGroupPermissions(sessionId, next, null)) } }}>{[...templates, ...(!templates.some(t => t.id === template.id) ? [template] : [])].map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <div className="voice-fields">{VISIBLE_TOOL_CATEGORIES.filter(k => k !== 'desktop').map(key => <label key={key}><input type="checkbox" checked={value.tool_access[key]} onChange={e => setValue({ ...value, tool_access: { ...value.tool_access, [key]: e.target.checked } })} />{TOOL_CATEGORY_LABELS[key]}</label>)}</div>
      <CliAccessEditor value={value.cli_access} onChange={cli_access => setValue({ ...value, cli_access })} />
      <label><input type="checkbox" checked={value.storage !== null} onChange={e => setValue({ ...value, storage: e.target.checked ? { workspace_path: '', access: 'read' } : null })} />启用存储</label>
      {value.storage && <div className="voice-fields"><label>工作区路径<input className="input" value={value.storage.workspace_path} onChange={e => setValue({ ...value, storage: { ...value.storage!, workspace_path: e.target.value } })} /></label><label>访问级别<select className="select" value={value.storage.access} onChange={e => setValue({ ...value, storage: { ...value.storage!, access: e.target.value as 'read' | 'readwrite' } })}><option value="read">只读</option><option value="readwrite">读写</option></select></label></div>}
      <label>记忆范围<input className="input" value={value.memory_scopes.join(', ')} onChange={e => setValue({ ...value, memory_scopes: e.target.value.split(',').map(s => s.trim()) })} /></label>
      <Button disabled={busy} onClick={() => void save()}>保存群权限</Button>
    </>}
  </div>
}
