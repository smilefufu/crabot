// Main-process-only bootstrap. Business requests remain in the shared HTTP/WS SDK.
import { randomBytes } from 'node:crypto'
import { readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DesktopChallengeSchema, DesktopSessionResponseSchema, DesktopSessionErrorSchema, LoopbackAdminOriginSchema, z } from 'crabot-client'
import identity from './process-identity.cjs'
import transport from './local-auth-transport.cjs'
import frameTransport from './desktop-frames.cjs'
import product from './product-runtime.cjs'
import { inspectInstance } from './instance-runtime.mjs'

const ProcessSchema = z.strictObject({ pid: z.number().int().positive(), parent: z.number().int().nonnegative(),
  owner: z.string().min(1), started: z.string().min(1), executable: z.string().min(1) })
const DiscoverySchema = z.strictObject({ schema_version: z.literal(1), instance_id: z.string(), generation: z.string(),
  server: ProcessSchema, socket_address: z.string().min(1).max(256), admin_url: LoopbackAdminOriginSchema })

function fail(code) { throw Object.assign(new Error('本机桌面会话不可用，请检查实例或重新连接。'), { code }) }
function readDiscovery(dataRoot, record) {
  const file = join(dataRoot, 'desktop-session.json'), stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536
    || (process.platform !== 'win32' && (String(stat.uid) !== record.controller.owner || (stat.mode & 0o077)))) fail('DESKTOP_UNAUTHORIZED')
  const bytes = readFileSync(file)
  if (bytes.length > 65536) fail('DESKTOP_PROTOCOL_ERROR')
  const description = DiscoverySchema.parse(JSON.parse(bytes.toString('utf8')))
  if (description.instance_id !== record.instance_id || description.generation !== record.generation) fail('DESKTOP_STALE_INSTANCE')
  const server = description.server
  if (server.owner !== record.mm.owner || server.parent !== record.mm.pid
    || !identity.sameProcess(server, identity.inspectProcess(server.pid))) fail('DESKTOP_UNAUTHORIZED')
  const runtime = product.loadProductRuntime(record.install_root, { required: existsSync(join(record.install_root, 'desktop-host.json')) })
  if (realpathSync(server.executable) !== realpathSync(runtime?.executables.node ?? process.execPath)) fail('DESKTOP_UNAUTHORIZED')
  const args = identity.inspectProcessArguments(server.pid)
  if (args.length !== 2 || realpathSync(args[1]) !== realpathSync(join(record.install_root, 'crabot-admin', 'dist', 'main.js'))
    || !identity.sameProcess(server, identity.inspectProcess(server.pid))) fail('DESKTOP_UNAUTHORIZED')
  if (description.socket_address !== transport.authAddress(dataRoot, server)) fail('DESKTOP_UNAUTHORIZED')
  return description
}

export async function openDesktopSession(dataRoot) {
  let socket, frames, expired = false
  const timer = setTimeout(() => { expired = true; frames?.fail(new Error('Desktop handshake timed out')); socket?.destroy() }, 5000)
  try {
    const instance = inspectInstance(dataRoot)
    if (instance.state !== 'running' || !instance.record?.mm
      || !identity.sameProcess(instance.record.mm, identity.inspectProcess(instance.record.mm.pid))) fail('DESKTOP_UNAVAILABLE')
    const record = instance.record, description = readDiscovery(dataRoot, record)
    const connection = await transport.connectLocalAuth(description.socket_address)
    socket = connection.socket
    if (expired || !identity.sameProcess(description.server, connection.peer)) fail('DESKTOP_UNAUTHORIZED')
    frames = new frameTransport.DesktopFrames(socket)
    const raw = await frames.read(), rejected = DesktopSessionErrorSchema.safeParse(raw)
    if (rejected.success) fail(rejected.data.code)
    const challenge = DesktopChallengeSchema.parse(raw)
    if (challenge.instance_id !== record.instance_id || challenge.generation !== record.generation) fail('DESKTOP_STALE_INSTANCE')
    const deadline = Date.parse(challenge.expires_at)
    if (deadline <= Date.now() || deadline > Date.now() + 5000) fail('DESKTOP_CHALLENGE_EXPIRED')
    frames.write({ type: 'open_session', protocol_version: 1, instance_id: record.instance_id, generation: record.generation,
      challenge: challenge.challenge, client_nonce: randomBytes(32).toString('base64url') })
    const response = await frames.read(), error = DesktopSessionErrorSchema.safeParse(response)
    if (error.success) fail(error.data.code)
    const session = DesktopSessionResponseSchema.parse(response)
    const latest = inspectInstance(dataRoot)
    if (expired || latest.state !== 'running' || latest.record.generation !== record.generation
      || !identity.sameProcess(latest.record.mm, identity.inspectProcess(latest.record.mm.pid))
      || session.instance_id !== record.instance_id || session.generation !== record.generation) fail('DESKTOP_STALE_INSTANCE')
    if (session.admin_url !== description.admin_url || Date.parse(session.expires_at) <= Date.now()
      || Date.parse(session.expires_at) > Date.now() + 15 * 60_000 || !identity.sameProcess(description.server, identity.inspectProcess(connection.peer.pid))) fail('DESKTOP_UNAUTHORIZED')
    return Object.freeze(session)
  } catch (error) {
    if (/^DESKTOP_[A-Z_]+$/.test(error?.code)) throw error
    fail(expired ? 'DESKTOP_CHALLENGE_EXPIRED' : 'DESKTOP_UNAVAILABLE')
  } finally { clearTimeout(timer); frames?.close(); socket?.destroy() }
}
