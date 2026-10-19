import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { RequestAuthority } from './RequestAuthority'
import type { WorkerRequestAuthorityView } from '../../services/agent-observability'
afterEach(cleanup)
const binding = { schema_version: 1 as const, request_id: 'r', source_sha256: 'h', execution_scope: 'request' as const }
const view = (): WorkerRequestAuthorityView => ({ status: 'verified', request_id: 'r', execution_scope: 'request',
  initiator: { channel_id: 'c', platform_user_id: 'original-user', display_name: '原发起人', friend_id: 'f' }, delivery: 'requester_private',
  permission_sources: { group: { kind: 'group', subject_id: 'c::g', is_master: false, resolved: { tool_access: { memory: true } as any, cli_access: {} as any, storage: null, memory_scopes: [] } },
    friend: { kind: 'friend', subject_id: 'f', is_master: true, resolved: { tool_access: { shell: true } as any, cli_access: { friend: 'write' } as any, storage: { workspace_path: '/B', access: 'readwrite' }, memory_scopes: [] } } } })
it('shows original initiator, separate ceilings and private delivery without claiming current grants', () => {
  render(<RequestAuthority binding={binding} authority={view()} />)
  expect(screen.getByText(/原始发起人：原发起人/)).toBeInTheDocument()
  expect(screen.getByText(/仅发起人私聊/)).toBeInTheDocument()
  expect(screen.getByText(/群公共来源/)).toBeInTheDocument(); expect(screen.getByText(/好友个人来源/)).toBeInTheDocument()
  expect(screen.getByText(/每次动作还要复核当前同一来源/)).toBeInTheDocument()
})
it('group execution hides the personal source even when a friend ceiling exists', () => {
  render(<RequestAuthority binding={{ ...binding, execution_scope: 'group' }} authority={{ ...view(), execution_scope: 'group' }} />)
  expect(screen.getByText(/仅群公共授权/)).toBeInTheDocument(); expect(screen.queryByText(/好友个人来源/)).not.toBeInTheDocument()
})
it('missing proof never falls back to a creator or recent speaker', () => {
  render(<RequestAuthority binding={binding} authority={{ status: 'unavailable', request_id: 'r', execution_scope: 'request' }} />)
  expect(screen.getByText(/请求来源无法核验/)).toBeInTheDocument(); expect(screen.queryByText(/原始发起人/)).not.toBeInTheDocument()
})
it('old tasks stay legacy rather than acquiring new authority', () => {
  render(<RequestAuthority />); expect(screen.getByText(/不追认个人授权/)).toBeInTheDocument()
})
it('stranger identity remains explicit', () => {
  render(<RequestAuthority binding={binding} authority={{ ...view(), initiator: { ...view().initiator!, friend_id: null } }} />)
  expect(screen.getByText(/陌生人/)).toBeInTheDocument()
})
