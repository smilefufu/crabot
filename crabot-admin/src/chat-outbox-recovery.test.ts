import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ChatManager } from './chat-manager.js'
import { MediaStore } from './media-store.js'

const managers: ChatManager[] = []
const directories: string[] = []
afterEach(async () => {
  managers.forEach(manager => manager.close()); managers.length = 0
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function manager(directory: string, call: (port: number, method: string, params: any) => Promise<unknown>) {
  const media = new MediaStore(directory); await media.init()
  const result = new ChatManager(directory, { callSensitive: call } as never, async () => 42,
    'outbox-test-secret', async () => ({ sub: 'admin' }), media)
  managers.push(result); await result.loadData()
  return result
}

it('a fifth unknown transport outcome stays pending, retries in-process, and recovers once after shutdown', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crabot-outbox-')); directories.push(directory)
  const file = path.join(directory, 'chat-inbound-dispatch-journal/recover.json')
  const message = { platform_message_id: 'user-message', session: { session_id: 'admin-chat', channel_id: 'admin-web', type: 'private' },
    sender: { friend_id: 'master', platform_user_id: 'master', platform_display_name: 'Master' },
    content: { type: 'text', text: '保留原始输入\r\n' }, features: { is_mention_crab: false }, platform_timestamp: new Date().toISOString() }
  const record = { kind: 'admin_chat_inbound_dispatch', request_id: 'recover', message, fingerprint: 'fixed-fingerprint',
    attempt: 4, status: 'pending_dispatch', created_at: message.platform_timestamp }
  await mkdir(path.dirname(file)); await writeFile(file, JSON.stringify(record))
  await writeFile(path.join(directory, 'chat_messages.json'), JSON.stringify([{ message_id: message.platform_message_id,
    role: 'user', content: message.content, request_id: 'recover', timestamp: message.platform_timestamp }]))
  let scheduled!: () => void
  const waiting = new Promise<void>(resolve => { scheduled = resolve })
  const originalTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 10_000) scheduled()
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const failed = vi.fn(async () => { throw new Error('EOF: acceptance outcome unknown') })
  const first = await manager(directory, failed)
  const running = (first as any).runInboundDispatch(record) as Promise<void>
  try {
    expect(await Promise.race([running.then(() => 'finished'), waiting.then(() => 'waiting')])).toBe('waiting')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ status: 'pending_dispatch', attempt: 5 })
  } finally { first.close(); await running }
  const initial = failed.mock.calls[0] as unknown as [number, string, any]
  let accept!: () => void
  const accepted = new Promise<void>(resolve => { accept = resolve })
  const replay = vi.fn(async (_port: number, _method: string, _params: any) => { await accepted; return {} })
  const second = await manager(directory, replay)
  await second.reconcileInboundDispatches()
  await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce())
  await second.reconcileInboundDispatches()
  expect(replay).toHaveBeenCalledOnce()
  const params = replay.mock.calls[0][2]
  expect(params.message).toEqual(initial[2].message)
  expect(params.source_type).toBe('admin_chat')
  expect(params.callback_info).toEqual({ source_module_id: 'admin-web', request_id: 'recover' })
  expect(params.admin_chat_assertion).not.toEqual(initial[2].admin_chat_assertion)
  expect(second.getMessages(10)).toHaveLength(1)
  expect(JSON.parse(await readFile(path.join(directory, 'chat-request-index.json'), 'utf8'))[0].status).toBe('pending')
  accept()
  await vi.waitFor(async () => { await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' }) })
})
