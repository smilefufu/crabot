import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { ComputerUseOwner, isStandardComputerUse } from '../src/agent/computer-use-owner.js'
import { retireOwnedLegacyComputerUse } from '../src/agent/computer-use-legacy.js'
import { defineTool } from '../src/engine/tool-framework.js'
import { UnifiedAgent } from '../src/unified-agent.js'
import { makeAgentConfig, useTmpDataDir } from './inbound/harness.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../src/workers/builtin/runtime.js'

const children: ChildProcess[] = []
const directories: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); if (child.exitCode === null && child.signalCode === null) await new Promise(done => child.once('exit', done)) }
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('computer-use trusted owner', () => {
  it('recognizes only the product launcher and keeps model arguments out of credentials', async () => {
    const product = { name: 'computer-use', command: 'node', args: ['/product/crabot-mcp-tools/dist/computer-use/main.js', '--crabot-standard'] }
    expect(isStandardComputerUse(product)).toBe(true)
    expect(isStandardComputerUse({ ...product, env: { USER_CUSTOM: '1' } })).toBe(false)
    const owner = new ComputerUseOwner(() => {}, () => '/unused', async () => {})
    let allowed = true
    const tool = defineTool({ name: 'mcp__computer-use__click', description: '', inputSchema: {}, isReadOnly: false,
      traceMetadata: { computer_use_standard: true }, call: async (input, context) => {
        const check = (owner as any).tokens.get(context.computerUseCredential)
        return { output: JSON.stringify(input), isError: !await check('call') }
      } })
    const bound = owner.bindTools([tool], 'worker:1:incarnation-a', async () => allowed)[0]
    expect((await bound.call({ computerUseCredential: 'forged-model-value' }, {} as never)).isError).toBe(false)
    allowed = false
    expect((await bound.call({}, {} as never)).isError).toBe(true)
    await owner.close()
    expect((owner as any).tokens.size).toBe(0)
  })
  it('reports driver quarantine while retaining the authorized recovery route and credentials', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'crabot-owner-recovery-'))
    directories.push(directory)
    const folder = join(directory, 'crabot-mcp-tools', 'dist', 'computer-use')
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(join(folder, 'service.js'), `
      process.on('message', message => {
        if (message.type === 'fixture') process.send({ type: 'availability', available: message.available })
      })
      process.on('disconnect', () => process.exit(0))
      process.send({ type: 'ready', endpoint: 'fixture-endpoint' })
    `)
    const owner = new ComputerUseOwner(() => {}, () => directory, async () => {})
    const product = { name: 'computer-use', command: 'node', args: [join(folder, 'main.js'), '--crabot-standard'] }
    try {
      const initial = await owner.prepare([product])
      const child = (owner as any).child as ChildProcess
      expect(owner.available).toBe(true)
      child.send({ type: 'fixture', available: false })
      await new Promise<void>(done => child.once('message', () => done()))
      expect(owner.available).toBe(false)
      expect(owner.connected).toBe(true)
      const again = await owner.prepare([product])
      expect((owner as any).child).toBe(child)
      expect(again[0].env).toEqual(initial[0].env)
      expect(owner.workerConfig('worker:live', async () => true)?.env?.CRABOT_COMPUTER_USE_ENDPOINT).toBe('fixture-endpoint')
      child.send({ type: 'fixture', available: true })
      await new Promise<void>(done => child.once('message', () => done()))
      expect(owner.available).toBe(true)
    } finally { await owner.close() }
    expect(owner.connected).toBe(false)
    expect(owner.available).toBe(false)
  })
  it('keeps the recovery tool in production capability assembly without widening permission or claiming ready guidance', async () => {
    const data = await useTmpDataDir('crabot-recovery-capabilities-')
    const agent: any = new UnifiedAgent(makeAgentConfig({ configured: true, moduleId: 'computer-use-cap-test', port: 19994 }))
    const product = { name: 'computer-use', command: 'node', args: ['/product/crabot-mcp-tools/dist/computer-use/main.js', '--crabot-standard'] }
    const principal = structuredClone(BUILTIN_WORKER_PERMISSIONS)
    principal.tool_access.mcp_skill = false
    principal.tool_access.desktop = true
    const snapshot = structuredClone(principal)
    try {
      agent.agentConfig = { ...agent.agentConfig, mcp_servers: [product], skills: [
        { id: 'builtin-skill-tmp-page', name: 'tmp-page', skill_dir: data.root },
      ], tmp_page_base_url: 'https://crabot.example' }
      const connected = vi.spyOn(agent.computerUseOwner, 'connected', 'get').mockReturnValue(true)
      expect(agent.computerUseOwner.available).toBe(false)
      for (const impl of ['builtin', 'claude-code', 'codex']) {
        const caps = await agent.managerStack.harness.deps.capabilityBundle({ worker_id: 'live-worker', impl, principal_permissions: principal })
        expect(caps.mcp_servers).toContainEqual(product)
        expect(caps.mcp_servers.find((server: any) => server.name === 'crabot-guidance')?.env).toBeUndefined()
        const denied = structuredClone(principal)
        denied.tool_access.desktop = false
        const deniedCaps = await agent.managerStack.harness.deps.capabilityBundle({ worker_id: 'denied', impl, principal_permissions: denied })
        expect(deniedCaps.mcp_servers.map((server: any) => server.name)).not.toContain('computer-use')
      }
      const ready = vi.spyOn(agent.computerUseOwner, 'available', 'get').mockReturnValue(true)
      const healthy = await agent.managerStack.harness.deps.capabilityBundle({ worker_id: 'live-worker', impl: 'codex', principal_permissions: principal })
      expect(healthy.mcp_servers.find((server: any) => server.name === 'crabot-guidance').env).toEqual({ CRABOT_COMPUTER_USE_GUIDANCE: '1' })
      ready.mockRestore()
      connected.mockReturnValue(false)
      const unavailable = await agent.managerStack.harness.deps.capabilityBundle({ worker_id: 'live-worker', impl: 'builtin', principal_permissions: principal })
      expect(unavailable.mcp_servers).toHaveLength(0)
      expect(principal).toEqual(snapshot)
    } finally {
      vi.restoreAllMocks()
      agent.attentionScheduler.stopAll()
      await agent.managerStack.dispose()
      await data.restore()
    }
  })
  it('authorizes the exact live incarnation, independent branches and fixed permission owner', async () => {
    const agent: any = Object.create(UnifiedAgent.prototype)
    const worker = { task: { status: 'running' }, incarnations: [
      { incarnation_id: 'old', state: 'idle' }, { incarnation_id: 'current', state: 'running' },
      { incarnation_id: 'branch', query_id: 'query', state: 'running' },
    ] }
    agent.managerStack = { ledger: { findWorker: async () => ({ worker }) } }
    expect(await agent.desktopWorkerCurrent('w', 'current')).toBe(true)
    expect(await agent.desktopWorkerCurrent('w', 'branch')).toBe(true)
    expect(await agent.desktopWorkerCurrent('w', 'old')).toBe(false)
    worker.incarnations[1].state = 'exited'
    expect(await agent.desktopWorkerCurrent('w', 'current')).toBe(false)
    worker.task.status = 'closed'
    expect(await agent.desktopWorkerCurrent('w', 'branch')).toBe(false)
  })
  it.skipIf(process.platform === 'win32')('retires the proven legacy child while keeping unrelated siblings alive', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'crabot-legacy-owned-'))
    directories.push(directory)
    const folder = join(directory, 'crabot-mcp-tools', 'dist', 'computer-use')
    await fs.mkdir(folder, { recursive: true })
    const launcher = join(folder, 'main.js')
    await fs.writeFile(launcher, 'setInterval(()=>{},1000)')
    const legacy = spawn(process.execPath, [launcher], { stdio: 'ignore' })
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    children.push(legacy, other)
    await Promise.all([legacy, other].map(child => new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail) })))
    expect(await retireOwnedLegacyComputerUse(new Set([process.pid]), new Set([launcher]))).toBe(1)
    expect(legacy.exitCode !== null || legacy.signalCode !== null).toBe(true)
    expect(other.exitCode).toBeNull()
    expect(other.signalCode).toBeNull()
  })
})
