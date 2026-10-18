import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { RequestDeliveryStore } from '../../src/manager/request-delivery-store.js'
import type { ConversationRequestRecord } from '../../src/manager/conversation-request.js'

let root: string
const request = { request_id: 'request', source_sha256: 'fixed-hash' } as ConversationRequestRecord
const target = { channel_id: 'chat', session_id: 'owner' }
const operation = { name: 'send_private_message', input: { friend_id: 'owner', content: 'PRIVATE_BODY', post_send_action: 'none' } }
const receipt = { platform_message_id: 'actual-message', sent_at: '2026-10-16T10:00:00.000Z' }
const authorize = async () => {}
const store = () => new RequestDeliveryStore(root, request)
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'request-delivery-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

it('persists responsibility before the network action, and reuses a confirmed receipt after restart', async () => {
  const send = vi.fn(async () => {
    expect((await fs.stat(path.join(root, 'delivery-pending.json'))).mode & 0o777).toBe(0o600)
    expect(await fs.readFile(path.join(root, 'delivery-pending.json'), 'utf8')).not.toContain('PRIVATE_BODY')
    return receipt
  })
  expect(await store().send(target, operation, authorize, send)).toEqual(receipt)
  expect(await store().send(target, operation, authorize, send)).toEqual(receipt)
  expect(send).toHaveBeenCalledTimes(1)
  expect(await store().unsettled()).toBe(false)
  const [file] = await fs.readdir(path.join(root, 'deliveries'))
  expect((await fs.stat(path.join(root, 'deliveries', file))).mode & 0o777).toBe(0o600)
})

it('keeps uncertain delivery across restart and blocks changed tools, bodies and targets from retrying it', async () => {
  const send = vi.fn(async () => { throw new Error('connection lost after acceptance') })
  await expect(store().send(target, operation, authorize, send)).rejects.toThrow('connection lost')
  expect(await store().unsettled()).toBe(true)
  await expect(store().send({ ...target, session_id: 'other' }, { ...operation, input: { content: 'changed' } }, authorize, send)).rejects.toThrow('DELIVERY_OUTCOME_UNKNOWN')
  expect(send).toHaveBeenCalledTimes(1)
})

it('mechanically acknowledges a persisted confirmation after a crash before pending cleanup', async () => {
  const send = vi.fn(async () => receipt)
  await store().send(target, operation, authorize, send)
  const [file] = await fs.readdir(path.join(root, 'deliveries'))
  const { receipt: _receipt, ...pending } = JSON.parse(await fs.readFile(path.join(root, 'deliveries', file), 'utf8'))
  await fs.writeFile(path.join(root, 'delivery-pending.json'), JSON.stringify(pending))
  expect(await store().unsettled()).toBe(false)
  expect(await store().send(target, operation, authorize, send)).toEqual(receipt)
  expect(send).toHaveBeenCalledTimes(1)
})

it('treats a missing real receipt as unknown', async () => {
  const send = vi.fn(async () => ({ buffered: true }))
  await expect(store().send(target, operation, authorize, send)).rejects.toThrow('DELIVERY_OUTCOME_UNKNOWN')
  expect(await store().unsettled()).toBe(true)
  expect(send).toHaveBeenCalledTimes(1)
})

it('fails closed on corrupt pending and confirmation files while preserving their bytes', async () => {
  const send = vi.fn(async () => receipt)
  await store().send(target, operation, authorize, send)
  const [name] = await fs.readdir(path.join(root, 'deliveries')), file = path.join(root, 'deliveries', name)
  await fs.writeFile(file, 'null')
  await expect(store().send(target, operation, authorize, send)).rejects.toThrow('Invalid delivery file')
  expect(await fs.readFile(file, 'utf8')).toBe('null'); expect(send).toHaveBeenCalledTimes(1)
  await fs.writeFile(path.join(root, 'delivery-pending.json'), '{"schema_version":99}')
  await expect(store().unsettled()).rejects.toThrow('Invalid request delivery record')
  expect(await fs.readFile(path.join(root, 'delivery-pending.json'), 'utf8')).toBe('{"schema_version":99}')
})

it('does not send when persistence fails or permission is revoked at final admission', async () => {
  const send = vi.fn(async () => receipt)
  await fs.writeFile(path.join(root, 'deliveries'), 'blocked')
  await expect(store().send(target, operation, authorize, send)).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
  await fs.rm(path.join(root, 'deliveries'))
  await expect(store().send(target, operation, async () => { throw new Error('revoked') }, send)).rejects.toThrow('revoked')
  expect(send).not.toHaveBeenCalled(); expect(await store().unsettled()).toBe(false)
})
