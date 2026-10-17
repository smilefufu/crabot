import { useEffect, useState } from 'react'
import type { VoiceTerminalState } from 'crabot-shared'
import { voiceService } from '../../services/voice'
import { VoiceServices } from './VoiceServices'
import { VoicePairing } from './VoicePairing'
import { VoiceContacts } from './VoiceContacts'
import { VoiceGroupConfig } from './VoiceGroupConfig'
import './voice-config.css'

export function VoiceConfigCard({ channelId, running, stage, ownerRequired = false, onState, onDirty }: { channelId: string; running: boolean; stage?: 'phone' | 'contacts' | 'summary'; ownerRequired?: boolean; onState?: (state?: VoiceTerminalState) => void; onDirty?: (dirty: boolean) => void }) {
  const [state, setState] = useState<VoiceTerminalState>()
  async function status() {
    const result = await voiceService.action(channelId, { action: 'status' })
    if (result.action === 'status') { setState(result.state); onState?.(result.state) }
  }
  useEffect(() => {
    if (!running) { setState(undefined); onState?.(undefined); return }
    let active = true
    const poll = async () => { try { const result = await voiceService.action(channelId, { action: 'status' }); if (active && result.action === 'status') { setState(result.state); onState?.(result.state) } } catch { if (active) { setState(undefined); onState?.(undefined) } } }
    void poll(); const timer = setInterval(() => { void poll() }, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [channelId, running])
  const activation = state?.owner_activation
  const ownerStatus = activation?.status === 'completed' ? `设备所有者 ${activation.owner.display_name} 已关联 Master` : activation ? `设备所有者 ${activation.owner.display_name} 正在关联 Master；请保持手机前台连接并重试同步` : ownerRequired ? '等待手机登记本人声纹并完成配对；关联完成后才能继续' : '既有设备保留原联系人与好友绑定，所有者引用将在核验后恢复'
  return <section className="voice-config" aria-label="语音渠道配置">
    <p>手机只在前台、现场开启后收音。后台不会远程打开麦克风。</p>
    {!stage && <VoiceServices channelId={channelId} />}
    {(!stage || stage === 'phone') && <VoicePairing channelId={channelId} running={running} state={state} onChanged={status} />}
    <p role="status">{ownerStatus}</p>
    {!stage && <VoiceContacts channelId={channelId} state={state} onChanged={status} />}
    {(!stage || stage === 'contacts') && <VoiceGroupConfig channelId={channelId} onDirty={onDirty} />}
    {stage === 'summary' && <p>{state?.paired && state.connected && state.foreground ? '手机已配对且在前台连接' : '请保持已配对手机在前台连接'}。完成时会检查群成员与配置，并重新测试 ASR/TTS；成功后才开启业务语音。</p>}
    <p>播放期间关麦，只能点按打断。识别准确率、唤醒误触发和整体延迟须以真机测试为准。</p>
  </section>
}
