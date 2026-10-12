import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { ComputerUseOwner, isStandardComputerUse } from '../src/agent/computer-use-owner.js'
import { retireOwnedLegacyComputerUse } from '../src/agent/computer-use-legacy.js'
import { defineTool } from '../src/engine/tool-framework.js'
import { UnifiedAgent } from '../src/unified-agent.js'

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
