import { useEffect, useRef, useState } from 'react'
import type { VoiceContact, VoiceTerminalState, VoiceManagementCommand, VoiceManagementRequest } from 'crabot-shared'
import { Button } from '../../components/Common/Button'
import { api } from '../../services/api'
import { friendService } from '../../services/friend'
import { permissionTemplateService } from '../../services/permission-template'
import { voiceService } from '../../services/voice'
import type { Friend, PermissionTemplate } from '../../types'

function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function VoiceContacts({ channelId, state, onChanged }: { channelId: string; state?: VoiceTerminalState; onChanged(): Promise<void> }) {
  const [contacts, setContacts] = useState<VoiceContact[]>([])
  const [friends, setFriends] = useState<Friend[]>([]), [templates, setTemplates] = useState<PermissionTemplate[]>([])
  const [name, setName] = useState(''), [contactId, setContactId] = useState(''), [friendId, setFriendId] = useState(''), [templateId, setTemplateId] = useState('')
  const [renameName, setRenameName] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const pendingRequest = useRef<VoiceManagementRequest | undefined>(undefined)
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
  async function manage(command: VoiceManagementCommand) {
    const previous = pendingRequest.current
    const request = previous && JSON.stringify(previous.command) === JSON.stringify(command) ? previous : { request_id: requestId(), expected_revision: state!.enrollment_revision, command }
    pendingRequest.current = request
    const result = await voiceService.action(channelId, { ...command, request_id: request.request_id, expected_revision: request.expected_revision })
    if (!('result' in result)) throw new Error('声纹管理结果无效；请核对状态')
    if (result.result.status === 'unknown') { await onChanged(); throw new Error('操作尚未确认，原请求已保留；请核对状态后重试') }
    pendingRequest.current = undefined
    if (result.result.status === 'rejected') { await onChanged(); throw new Error(result.result.message ?? '操作拒绝，请核对最新目录') }
    await onChanged()
    setNotice(result.result.status === 'pending' ? '录入任务已建立；手机现场完成后才生成正式联系人' : '后台已提交，终端同步状态见列表')
  }
  async function enrollNew() {
    await manage({ action: 'enroll_new', display_name: name.trim() }); setName('')
  }
  async function bindExisting() {
    await friendService.linkIdentity(friendId, identity!)
    setContacts(current => current.map(c => c.platform_user_id === contactId ? { ...c, friend_id: friendId } : c))
    await refresh(); setNotice('好友已绑定；新发言按当前绑定标注')
  }
  async function createFriend() {
    const result = await api.post<{ friend: Friend }>('/friends', {
      display_name: selected!.display_name, permission: 'normal', permission_template_id: templateId, channel_identities: [identity],
    })
    setContacts(current => current.map(c => c.platform_user_id === contactId ? { ...c, friend_id: result.friend.id } : c))
    await refresh(); setNotice('普通好友已创建并绑定；语音发言仍使用群权限')
  }
  async function unlink(contact: VoiceContact) {
    await friendService.unlinkIdentity(contact.friend_id!, channelId, contact.platform_user_id)
    setContacts(current => current.map(c => c.platform_user_id === contact.platform_user_id ? { platform_user_id: c.platform_user_id, display_name: c.display_name } : c))
    await refresh()
  }

  return <div>
    <h4>渠道联系人与声纹</h4><p>联系人、好友绑定和声纹分别管理。未绑定或未识别的发言按陌生人进入语音群；声纹不授予权限，删除声纹保留联系人与绑定。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="voice-fields"><label>录入名字<input className="input" value={name} maxLength={128} onChange={e => setName(e.target.value)} /></label></div>
    <Button disabled={busy || !state || !name.trim() || !state.connected || !state.foreground || !!state.pending_enrollment} onClick={() => void run(enrollNew)}>登记新联系人</Button>
    {state?.pending_enrollment && <div role="status"><p>正在录入：{state.pending_enrollment.registration.display_name}。完成并确认前不列入正式联系人。</p><Button disabled={busy} onClick={() => void run(() => manage({ action: 'cancel_enrollment', registration_id: state.pending_enrollment!.registration.registration_id }))}>取消录入</Button></div>}
    {state?.unconfirmed_contacts.map(contact => <div className="voice-service-row" key={contact.platform_user_id}><span>{contact.display_name} · 旧记录尚未核验，原身份和绑定保留</span><Button disabled={busy || !state.connected || !state.foreground || !!state.pending_enrollment} onClick={() => void run(() => manage({ action: 'enroll', platform_user_id: contact.platform_user_id }))}>重新登记确认</Button></div>)}
    {contacts.map(contact => {
      const registration = state?.registrations.find(r => r.platform_user_id === contact.platform_user_id && r.status !== 'revoked')
      const revoked = state?.registrations.filter(r => r.platform_user_id === contact.platform_user_id && r.status === 'revoked').at(-1)
      const friend = friends.find(f => f.id === contact.friend_id)
      return <div className="voice-service-row" key={contact.platform_user_id}><span><strong>{contact.display_name}</strong> · {contact.friend_id ? `已绑定 ${friend?.display_name ?? contact.friend_id}` : '未绑定好友（群内按陌生人）'}<br /><small>{registration?.status === 'active' ? '声纹可用' : registration?.status === 'pending' ? '等待手机现场登记' : revoked && !revoked.terminal_cleared ? '声纹已撤销，终端清除待完成' : '未登记声纹'}</small></span><div className="voice-actions">
        <Button disabled={busy || !state?.connected || !state.foreground || !!state.pending_enrollment} onClick={() => void run(() => manage({ action: 'enroll', platform_user_id: contact.platform_user_id }))}>{registration?.status === 'active' ? '重新录制' : '登记声纹'}</Button>
        {registration && <Button variant="danger" disabled={busy} onClick={() => void run(() => manage({ action: 'delete_registration', registration_id: registration.registration_id }))}>删除声纹</Button>}
        {contact.friend_id && <Button variant="secondary" disabled={busy} onClick={() => void run(() => unlink(contact))}>解绑好友</Button>}
      </div></div>
    })}
    <div className="voice-fields"><label>绑定的渠道联系人<select className="select" value={contactId} onChange={e => setContactId(e.target.value)}><option value="">选择联系人</option>{contacts.map(c => <option key={c.platform_user_id} value={c.platform_user_id}>{c.display_name}</option>)}</select></label><label>已有好友<select className="select" value={friendId} onChange={e => setFriendId(e.target.value)}><option value="">选择好友</option>{friends.map(f => <option key={f.id} value={f.id}>{f.display_name}</option>)}</select></label></div>
    <Button disabled={busy || !identity || !!selected?.friend_id || !friendId} onClick={() => void run(bindExisting)}>绑定已有好友</Button>
    <div className="voice-fields"><label>修改联系人名字<input className="input" value={renameName} maxLength={128} onChange={e => setRenameName(e.target.value)} /></label></div>
    <Button variant="secondary" disabled={busy || !selected || !renameName.trim() || !!state?.pending_enrollment} onClick={() => void run(() => manage({ action: 'rename_contact', platform_user_id: selected!.platform_user_id, display_name: renameName.trim() }))}>修改名字</Button>
    <div className="voice-fields"><label>新好友权限模板<select className="select" value={templateId} onChange={e => setTemplateId(e.target.value)}><option value="">选择已有模板</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>
    <Button variant="secondary" disabled={busy || !identity || !!selected?.friend_id || !templateId} onClick={() => void run(createFriend)}>创建并绑定普通好友</Button>
  </div>
}
