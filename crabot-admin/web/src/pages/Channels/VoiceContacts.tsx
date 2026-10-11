import { useEffect, useState } from 'react'
import type { VoiceContact, VoiceTerminalState } from 'crabot-shared'
import { Button } from '../../components/Common/Button'
import { api } from '../../services/api'
import { friendService } from '../../services/friend'
import { permissionTemplateService } from '../../services/permission-template'
import { voiceService } from '../../services/voice'
import type { Friend, PermissionTemplate } from '../../types'

export function VoiceContacts({ channelId, state, onChanged }: { channelId: string; state?: VoiceTerminalState; onChanged(): Promise<void> }) {
  const [contacts, setContacts] = useState<VoiceContact[]>([])
  const [friends, setFriends] = useState<Friend[]>([]), [templates, setTemplates] = useState<PermissionTemplate[]>([])
  const [name, setName] = useState(''), [contactId, setContactId] = useState(''), [friendId, setFriendId] = useState(''), [templateId, setTemplateId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const selected = contacts.find(c => c.platform_user_id === contactId)
  async function loadFriends() {
    const [f, t] = await Promise.all([friendService.listFriends({ page_size: 100 }), permissionTemplateService.list({ page_size: 100 })])
    setFriends(f.items); setTemplates(t.items.filter(p => p.id !== 'master_private'))
  }
  useEffect(() => { if (state) setContacts(state.contacts) }, [state])
  useEffect(() => { void loadFriends().catch(e => setError(e.message)) }, [channelId])
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : '联系人操作失败') } finally { setBusy(false) }
  }
  async function refresh() { await loadFriends(); if (state) await onChanged() }
  const identity = selected && { channel_id: channelId, platform_user_id: selected.platform_user_id, platform_display_name: selected.display_name }
  async function createContact() {
    const result = await voiceService.action(channelId, { action: 'create_contact', display_name: name.trim() })
    if (result.action !== 'create_contact') throw new Error('联系人创建结果无效')
    setContacts(current => [...current, result.contact]); setContactId(result.contact.platform_user_id); setName('')
    setNotice('联系人已创建，可绑定 Friend 或登记声纹')
  }
  async function bindExisting() {
    await friendService.linkIdentity(friendId, identity!)
    setContacts(current => current.map(c => c.platform_user_id === contactId ? { ...c, friend_id: friendId } : c))
    await refresh(); setNotice('Friend 已绑定；新发言按当前绑定标注')
  }
  async function createFriend() {
    const result = await api.post<{ friend: Friend }>('/friends', {
      display_name: selected!.display_name, permission: 'normal', permission_template_id: templateId, channel_identities: [identity],
    })
    setContacts(current => current.map(c => c.platform_user_id === contactId ? { ...c, friend_id: result.friend.id } : c))
    await refresh(); setNotice('普通 Friend 已创建并绑定；语音发言仍使用群权限')
  }
  async function unlink(contact: VoiceContact) {
    await friendService.unlinkIdentity(contact.friend_id!, channelId, contact.platform_user_id)
    setContacts(current => current.map(c => c.platform_user_id === contact.platform_user_id ? { platform_user_id: c.platform_user_id, display_name: c.display_name } : c))
    await refresh()
  }

  return <div>
    <h4>渠道联系人与声纹</h4><p>联系人、Friend 绑定和声纹分别管理。未绑定或未识别的发言按陌生人进入语音群；声纹不授予权限，删除声纹保留联系人与绑定。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="voice-fields"><label>联系人名称<input className="input" value={name} onChange={e => setName(e.target.value)} /></label></div>
    <Button disabled={busy || !name.trim()} onClick={() => void run(createContact)}>创建渠道联系人</Button>
    {contacts.map(contact => {
      const registration = state?.registrations.find(r => r.platform_user_id === contact.platform_user_id && r.status !== 'revoked')
      const revoked = state?.registrations.filter(r => r.platform_user_id === contact.platform_user_id && r.status === 'revoked').at(-1)
      const friend = friends.find(f => f.id === contact.friend_id)
      return <div className="voice-service-row" key={contact.platform_user_id}><span><strong>{contact.display_name}</strong> · {contact.friend_id ? `已绑定 ${friend?.display_name ?? contact.friend_id}` : '未绑定 Friend（群内按陌生人）'}<br /><small>{registration?.status === 'active' ? '声纹可用' : registration?.status === 'pending' ? '等待手机现场登记' : revoked && !revoked.terminal_cleared ? '声纹已撤销，终端清除待完成' : '未登记声纹'}</small></span><div className="voice-actions">
        {registration ? <Button variant="danger" disabled={busy} onClick={() => void run(async () => { await voiceService.action(channelId, { action: 'delete_registration', registration_id: registration.registration_id }); await onChanged() })}>删除声纹</Button> : <Button disabled={busy || !state?.connected || !state.foreground || state.registrations.some(r => r.status === 'pending')} onClick={() => void run(async () => { await voiceService.action(channelId, { action: 'enroll', platform_user_id: contact.platform_user_id }); await onChanged() })}>登记声纹</Button>}
        {contact.friend_id && <Button variant="secondary" disabled={busy} onClick={() => void run(() => unlink(contact))}>解绑 Friend</Button>}
      </div></div>
    })}
    <div className="voice-fields"><label>绑定的渠道联系人<select className="select" value={contactId} onChange={e => setContactId(e.target.value)}><option value="">选择联系人</option>{contacts.map(c => <option key={c.platform_user_id} value={c.platform_user_id}>{c.display_name}</option>)}</select></label><label>已有 Friend<select className="select" value={friendId} onChange={e => setFriendId(e.target.value)}><option value="">选择对话对象</option>{friends.map(f => <option key={f.id} value={f.id}>{f.display_name}</option>)}</select></label></div>
    <Button disabled={busy || !identity || !!selected?.friend_id || !friendId} onClick={() => void run(bindExisting)}>绑定已有 Friend</Button>
    <div className="voice-fields"><label>新 Friend 权限模板<select className="select" value={templateId} onChange={e => setTemplateId(e.target.value)}><option value="">选择已有模板</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>
    <Button variant="secondary" disabled={busy || !identity || !!selected?.friend_id || !templateId} onClick={() => void run(createFriend)}>创建并绑定普通 Friend</Button>
  </div>
}
