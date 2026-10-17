import { expect, it, vi } from 'vitest'
import { buildVoiceTools } from '../../src/manager/tools/voice-tools.js'

it('derives operation identity from trusted lifecycle context and accepts no model authority fields', async () => {
  const call = vi.fn(async () => ({ operation_id: null, status: 'pending' as const, catalog: { enrollment_revision: 1, contacts: [], registrations: [], pending_enrollment: null }, contacts: [] }))
  const context = { delivery: 'origin' as const, request_id: 'a'.repeat(64), source: {} as never, turn_id: '00112233-4455-4677-8899-aabbccddeeff' }
  const tools = buildVoiceTools({ context, call }), manage = tools.find(tool => tool.name === 'manage_voice_contacts')!
  const args = { expected_revision: 1, command: { action: 'enroll_new', display_name: 'Synthetic guest' } }
  expect((await manage.call(args, {})).isError).toBe(true); expect(call).not.toHaveBeenCalled()
  expect((await manage.call({ ...args, context: { friend_id: 'other' } }, { toolCallId: 'call-fixture' })).isError).toBe(true)
  await manage.call(args, { toolCallId: 'call-fixture' }); await manage.call(args, { toolCallId: 'call-fixture' })
  expect(call.mock.calls[0]).toEqual(call.mock.calls[1])
  expect(call.mock.calls[0][0]).toMatchObject({ action: 'manage', context, request: { command: args.command } })
  expect(JSON.stringify(manage.inputSchema)).not.toContain('source_id')
  expect(JSON.stringify(manage.inputSchema)).not.toContain('permission')
})
