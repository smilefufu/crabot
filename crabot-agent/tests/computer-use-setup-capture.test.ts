import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ComputerUseOwner } from '../src/agent/computer-use-owner.js'

const { createComputerUseBridge } = require('../../crabot-mcp-tools/dist/computer-use/service.js')
const { ComputerUseCoordinator } = require('../../crabot-mcp-tools/dist/computer-use/coordinator.js')
const { NATIVE_TOOLS } = require('../../crabot-mcp-tools/dist/computer-use/types.js')
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFf0AAAAASUVORK5CYII=' }

async function fixture(capture: () => Promise<any>) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'cu-setup-capture-'))
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }))
  const folder = path.join(directory, 'crabot-mcp-tools/dist/computer-use')
  await fs.mkdir(folder, { recursive: true })
  // Exercise the product client used by Owner, with the same instance bridge and coordinator.
  await fs.copyFile(path.resolve(__dirname, '../../crabot-mcp-tools/dist/computer-use/client.js'), path.join(folder, 'client.js'))
  const owner: any = new ComputerUseOwner(() => {}, () => directory, async () => {})
  const calls: string[] = []
  const coordinator = new ComputerUseCoordinator({
    async tools() { return NATIVE_TOOLS.map((name: string) => ({ name, inputSchema: { type: 'object', properties: { session: { type: 'string' }, max_image_dimension: { type: 'integer' } }, additionalProperties: false } })) },
    async call(name: string) { calls.push(name); return name === 'get_desktop_state' ? capture() : { content: [] } }, async close() {},
  }, async (token: string) => owner.tokens.get(token)?.('call') ?? false)
  const bridge = createComputerUseBridge(coordinator, async (token: string, method: string, name: string) => owner.tokens.get(token)?.(method, name) ?? false)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cu-setup-capture-${Date.now()}` : path.join(directory, 's.sock')
  await new Promise<void>(done => bridge.server.listen(endpoint, done))
  owner.config = { name: 'computer-use', command: 'node', args: [path.join(folder, 'main.js'), '--crabot-standard'] }
  owner.endpoint = endpoint; owner.ready = true
  owner.child = { connected: true, send: (message: any) => { if (message.type === 'revoke') void coordinator.revoke(message.token) } }
  cleanup.push(async () => { owner.child = undefined; await owner.close(); bridge.close(); await coordinator.close() })
  return { owner: owner as ComputerUseOwner, calls, request: { setup_id: 'explicit-setup', expires_at: new Date(Date.now() + 60000).toISOString() } }
}

describe('ephemeral host screenshot verification', () => {
  it('observes once through the product bridge, discards image bytes, and revokes its credential', async () => {
    const { owner, calls, request } = await fixture(async () => ({ content: [image] }))
    await owner.verifySetup(request, () => true)
    await owner.verifySetup(request, () => true)
    expect(calls.filter(name => name === 'get_desktop_state')).toHaveLength(1)
    expect(owner.status.capture).toMatchObject({ setup_id: request.setup_id, status: 'verified' })
    expect(JSON.stringify(owner.status)).not.toContain(image.data)
    expect((owner as any).tokens.size).toBe(0)
    expect(calls.some(name => ['click', 'type_text'].includes(name))).toBe(false)
  })
  it('does not accept a successful text response as screenshot evidence', async () => {
    const { owner, request } = await fixture(async () => ({ content: [{ type: 'text', text: 'permissions granted' }] }))
    await owner.verifySetup(request, () => true)
    expect(owner.status.capture?.status).toBe('failed')
    expect((owner as any).tokens.size).toBe(0)
  })
  it('discards a late image after the human operation is cancelled', async () => {
    let started!: () => void, finish!: (result: any) => void
    const observing = new Promise<void>(done => { started = done })
    const { owner, request } = await fixture(() => { started(); return new Promise(done => { finish = done }) })
    let current = true
    const pending = owner.verifySetup(request, () => current)
    await observing
    current = false; owner.cancelSetupVerification()
    await pending; finish({ content: [image] })
    expect(owner.status.capture).toBeUndefined()
    expect((owner as any).tokens.size).toBe(0)
  })
})
