import type { LedgerWorker, WorkerRequestAuthorityView } from '../../services/agent-observability'
import { TOOL_CATEGORY_LABELS, CLI_DOMAIN_LABELS, VISIBLE_TOOL_CATEGORIES } from '../../types'

export function RequestAuthority({ authority, binding }: { authority?: WorkerRequestAuthorityView; binding?: LedgerWorker['origin']['request'] }) {
  if (!binding) return <section aria-label="请求授权"><h2 style={{ fontSize: 16 }}>请求授权</h2><p>旧任务或非人类请求：保留原主体快照，不追认个人授权。</p></section>
  if (!authority || authority.status !== 'verified') return <section aria-label="请求授权"><h2 style={{ fontSize: 16 }}>请求授权</h2><p>请求来源无法核验，后续动作关闭。不会从创建者或最近发言人补推权限。</p><small>{binding.request_id}</small></section>
  const person = authority.initiator
  const sources = authority.permission_sources
  return <section aria-label="请求授权" style={{ margin: '24px 0' }}>
    <h2 style={{ fontSize: 16 }}>请求授权</h2>
    <p>原始发起人：{person?.display_name || person?.platform_user_id} · {person?.friend_id ? `好友 ${person.friend_id}` : '陌生人'}（{person?.channel_id} / {person?.platform_user_id}）</p>
    <p>执行范围：{authority.execution_scope === 'group' ? '仅群公共授权' : '独立请求，逐完整来源校验'}；交付：{authority.delivery === 'requester_private' ? '仅发起人私聊' : '原会话'}</p>
    <details><summary>创建时的授权上限</summary>
      {[sources?.group, ...(authority.execution_scope === 'request' ? [sources?.friend] : [])].map(source => source && <div key={source.kind}>
        <strong>{source.kind === 'group' ? '群公共来源' : '好友个人来源'} · {source.subject_id}{source.is_master ? ' · Master' : ''}</strong>
        <p>工具入口：{Object.entries(source.resolved.tool_access).filter(([key, allowed]) => allowed && (VISIBLE_TOOL_CATEGORIES as readonly string[]).includes(key)).map(([key]) => TOOL_CATEGORY_LABELS[key as keyof typeof TOOL_CATEGORY_LABELS] ?? key).join('、') || '无'}</p>
        <p>CLI：{Object.entries(source.resolved.cli_access).filter(([, access]) => access !== 'none').map(([key, access]) => `${CLI_DOMAIN_LABELS[key as keyof typeof CLI_DOMAIN_LABELS] ?? key} ${access}`).join('、') || '无'}</p>
        <p>额外文件范围：{source.resolved.storage ? `${'scope' in source.resolved.storage ? '允许所有目录' : source.resolved.storage.workspace_path} · ${source.resolved.storage.access}` : '未授权额外目录'}</p>
        <p>记忆过滤：{source.resolved.memory_scopes.join('、') || (source.kind === 'group' ? '按原群会话过滤' : '不额外过滤')}</p>
      </div>)}
    </details>
    <p>以上是分立创建上限。每次动作还要复核当前同一来源及执行器角色限制；实际装配见下方记录。</p>
    <small>请求：{authority.request_id}</small>
  </section>
}
