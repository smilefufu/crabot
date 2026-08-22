/**
 * Opt-in black-box coverage for the real interactive CLIs.
 *
 * This intentionally does not use mock-cli. It costs real model calls, so it
 * is skipped unless CRABOT_REAL_CLI_E2E=1 is set explicitly.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import { WorkerHarness, type HarnessDeps } from '../../src/workers/harness/harness.js'
import { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import type { ManagerKey } from '../../src/workers/harness/ledger-types.js'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import type { HarnessEvent } from '../../src/workers/harness/worker-events.js'
import { TmuxDriver } from '../../src/workers/tmux/driver.js'
import type { IncarnationHandle, WorkerAdapter, WorkerContractState, WorkerImplId } from '../../src/workers/types.js'

const enabled = process.env.CRABOT_REAL_CLI_E2E === '1'
const tmux = new TmuxDriver()
const sessionPrefix = 'crabot-w-real-tui-e2e-'
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude'
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex'

type CliAdapter = ClaudeCodeAdapter | CodexWorkerAdapter

type RealCliSetupOptions = {
  prompt?: string
  claudeBinFactory?: (root: string) => Promise<string>
}

type HarnessCliSetupOptions = {
  forcePermission?: boolean
  prompt?: string
}

async function waitFor(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function waitForState(
  adapter: CliAdapter,
  handle: IncarnationHandle,
  state: WorkerContractState,
  timeoutMs = 45_000,
): Promise<void> {
  try {
    await waitFor(async () => (await adapter.state(handle)) === state, `state=${state}`, timeoutMs)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}:\n${await paneText(adapter, handle)}`)
  }
}

async function paneText(adapter: CliAdapter, handle: IncarnationHandle): Promise<string> {
  const terminal = await adapter.readTerminal(handle)
  return terminal.kind === 'unavailable' ? '' : terminal.text
}

async function waitForPane(adapter: CliAdapter, handle: IncarnationHandle, text: string, timeoutMs = 45_000): Promise<void> {
  try {
    await waitFor(async () => (await paneText(adapter, handle)).includes(text), `pane text ${text}`, timeoutMs)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}:\n${await paneText(adapter, handle)}`)
  }
}

function cleanupOwnedTmuxSessions(): void {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf-8' })
    for (const session of output.split('\n').map((item) => item.trim()).filter((item) => item.startsWith(sessionPrefix))) {
      execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
    }
  } catch {
    // No sessions or tmux exiting concurrently is fine during cleanup.
  }
}

async function setup(kind: 'claude' | 'codex', options: RealCliSetupOptions = {}): Promise<{
  adapter: CliAdapter
  workspace: string
  dataDir: string
  handle: IncarnationHandle
}> {
  const root = await fs.mkdtemp(join(os.tmpdir(), `crabot-real-tui-${kind}-`))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'adapter-data')
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(join(workspace, 'AGENTS.md'), 'Work only in this temporary E2E workspace.\n', 'utf-8')

  const workerId = `real-tui-e2e-${kind}-${randomUUID().slice(0, 8)}`
  const claudeBin = kind === 'claude' && options.claudeBinFactory
    ? await options.claudeBinFactory(root)
    : CLAUDE_BIN
  const adapter: CliAdapter = kind === 'claude'
    ? new ClaudeCodeAdapter({
      dataDir,
      claudeBin,
      pasteReadyTimeoutMs: 20_000,
    })
    : new CodexWorkerAdapter({
      dataDir,
      codexBin: CODEX_BIN,
      codexHomeSource: join(os.homedir(), '.codex'),
      pasteReadyTimeoutMs: 20_000,
      sessionDiscoveryTimeoutMs: 20_000,
    })

  await adapter.provision({ root: workspace }, { skills: [], mcp_servers: [] })
  const padding = 'input-verification-padding '.repeat(80)
  const handle = await adapter.spawn({
    worker_id: workerId,
    prompt: options.prompt ?? `Reply with exactly E2E_${kind.toUpperCase()}_INITIAL_OK. Do not edit files. Ignore this padding: ${padding}`,
    workspace: { root: workspace },
  })
  return { adapter, workspace, dataDir: root, handle }
}

async function clearClaudeTestTrust(workspace: string): Promise<void> {
  const configPath = join(os.homedir(), '.claude.json')
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const config = JSON.parse(raw) as { projects?: Record<string, unknown> }
  const realWorkspace = await fs.realpath(workspace)
  if (!config.projects?.[realWorkspace]) return
  delete config.projects[realWorkspace]
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

async function finish(adapter: CliAdapter, handle: IncarnationHandle, root: string): Promise<void> {
  await adapter.stop(handle).catch(() => {})
  await adapter.dispose().catch(() => {})
  const workspace = join(root, 'workspace')
  await clearClaudeTestTrust(workspace)
  await fs.rm(root, { recursive: true, force: true })
}

function recreateAdapter(kind: 'claude' | 'codex', root: string): CliAdapter {
  return kind === 'claude'
    ? new ClaudeCodeAdapter({
      dataDir: join(root, 'adapter-data'),
      claudeBin: CLAUDE_BIN,
      pasteReadyTimeoutMs: 20_000,
    })
    : new CodexWorkerAdapter({
      dataDir: join(root, 'adapter-data'),
      codexBin: CODEX_BIN,
      codexHomeSource: join(os.homedir(), '.codex'),
      pasteReadyTimeoutMs: 20_000,
      sessionDiscoveryTimeoutMs: 20_000,
    })
}

function binaryPath(command: string): string {
  return execFileSync('/bin/sh', ['-lc', `command -v ${command}`], { encoding: 'utf-8' }).trim()
}

async function writePermissionWrapper(root: string, kind: 'claude' | 'codex'): Promise<string> {
  const target = kind === 'claude' ? binaryPath(CLAUDE_BIN) : binaryPath(CODEX_BIN)
  const file = join(root, `${kind}-permission-wrapper.sh`)
  const filter = kind === 'claude'
    ? 'if [[ "$1" == "--permission-mode" ]]; then shift 2; continue; fi'
    : 'if [[ "$1" == "--approve-for-me" ]]; then shift; continue; fi\n  if [[ "$1" == "--ask-for-approval" ]]; then shift 2; continue; fi'
  const prefix = kind === 'claude'
    ? 'exec ' + JSON.stringify(target) + ' --permission-mode manual'
    : 'exec ' + JSON.stringify(target) + ' --ask-for-approval untrusted'
  await fs.writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\nargs=()\nwhile (( $# )); do\n  ${filter}\n  args+=("$1")\n  shift\ndone\n${prefix} "${'${args[@]}'}"\n`, { mode: 0o700 })
  return file
}

async function writeClaudePlanWrapper(root: string): Promise<string> {
  const target = binaryPath(CLAUDE_BIN)
  const file = join(root, 'claude-plan-wrapper.sh')
  await fs.writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\nargs=()\nwhile (( $# )); do\n  if [[ "$1" == "--permission-mode" ]]; then shift 2; continue; fi\n  args+=("$1")\n  shift\ndone\nexec ${JSON.stringify(target)} --permission-mode plan "${'${args[@]}'}"\n`, { mode: 0o700 })
  return file
}

async function cliEventsText(workspace: string, kind: 'claude' | 'codex'): Promise<string> {
  const dir = kind === 'claude' ? '.claude' : '.codex'
  return fs.readFile(join(workspace, dir, 'events-cli.jsonl'), 'utf-8').catch(() => '<no hook events file>')
}

async function terminalContains(harness: WorkerHarness, workerId: string, text: string): Promise<boolean> {
  const terminal = await harness.getWorkerTerminal(workerId)
  return terminal.kind !== 'unavailable' && terminal.text.includes(text)
}

async function setupHarnessWorker(kind: 'claude' | 'codex', options: HarnessCliSetupOptions = {}): Promise<{
  root: string
  workspace: string
  adapter: CliAdapter
  harness: WorkerHarness
  workerId: string
  events: HarnessEvent[]
  managerKey: ManagerKey
  permissionFile?: string
}> {
  const root = await fs.mkdtemp(join(os.tmpdir(), `crabot-real-ui-${kind}-`))
  const workspace = join(root, 'workspace')
  const workerRoot = join(root, 'workers')
  const permissionFile = options.forcePermission ? join(root, `${kind}-permission.txt`) : undefined
  await fs.mkdir(workspace, { recursive: true })
  const adapters = new Map<WorkerImplId, WorkerAdapter>()
  const events: HarnessEvent[] = []
  const managerKey = `wechat::real-tui-${kind}-${randomUUID()}` as ManagerKey
  const harness = new WorkerHarness({
    adapters,
    defaultImpl: kind === 'claude' ? 'claude-code' : 'codex',
    ledger: new LedgerStore(join(root, 'ledgers')),
    workspaces: new WorkspaceManager(join(root, 'workspaces')),
    workersDir: workerRoot,
    now: () => new Date().toISOString(),
    onEvent: (event) => { events.push(event) },
  } satisfies HarnessDeps)
  const cliBin = options.forcePermission ? await writePermissionWrapper(root, kind) : undefined
  const adapter: CliAdapter = kind === 'claude'
    ? new ClaudeCodeAdapter({ dataDir: join(root, 'adapter-data'), claudeBin: cliBin ?? CLAUDE_BIN, onStateChange: harness.handleStateChange })
    : new CodexWorkerAdapter({
      dataDir: join(root, 'adapter-data'),
      codexBin: cliBin ?? CODEX_BIN,
      codexHomeSource: join(os.homedir(), '.codex'),
      onStateChange: harness.handleStateChange,
      sessionDiscoveryTimeoutMs: 20_000,
    })
  adapters.set(adapter.implId, adapter)
  const worker = await harness.spawnWorker({
    managerKey,
    title: `real ${kind} CLI worker`,
    prompt: options.prompt ?? (permissionFile
      ? `Use the shell command printf approved > ${permissionFile} to create that file outside the workspace. Do not use an editor or patch tool. Do not do anything else.`
      : `Reply with exactly E2E_${kind.toUpperCase()}_HARNESS_INITIAL_OK. Do not edit files.`),
    origin: { trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'real-tui-e2e' },
    impl: adapter.implId,
    workspace,
  })
  return { root, workspace, adapter, harness, workerId: worker.worker_id, events, managerKey, permissionFile }
}

function setupHarnessPermissionWorker(kind: 'claude' | 'codex') {
  return setupHarnessWorker(kind, { forcePermission: true })
}

async function cleanupHarnessPermissionWorker(test: Awaited<ReturnType<typeof setupHarnessPermissionWorker>>): Promise<void> {
  await test.harness.requestWorkerStop(test.workerId).catch(() => {})
  await test.adapter.dispose().catch(() => {})
  await clearClaudeTestTrust(test.workspace)
  await fs.rm(test.root, { recursive: true, force: true })
}

describe.skipIf(!enabled)('real CLI tmux E2E', () => {
  afterEach(() => cleanupOwnedTmuxSessions())

  for (const kind of ['claude', 'codex'] as const) {
    it(`${kind}: initial input, idle follow-up, steering, interrupt, restart reattach, and stop`, async () => {
      const { adapter, workspace, dataDir, handle } = await setup(kind)
      let currentAdapter = adapter
      let currentHandle = handle
      const runningMarker = kind === 'claude' ? 'esc to interrupt' : 'Working'
      try {
        if (currentHandle.initial_input?.disposition !== 'accepted') {
          throw new Error(
            `initial input was ${currentHandle.initial_input?.disposition ?? 'missing'}:\n` +
            await paneText(currentAdapter, currentHandle),
          )
        }
        await waitForState(currentAdapter, currentHandle, 'idle')
        await waitForPane(currentAdapter, currentHandle, `E2E_${kind.toUpperCase()}_INITIAL_OK`)

        await currentAdapter.sendInput(currentHandle, `Reply with exactly E2E_${kind.toUpperCase()}_FOLLOWUP_OK. Do not edit files.`)
        await waitForState(currentAdapter, currentHandle, 'idle')
        await waitForPane(currentAdapter, currentHandle, `E2E_${kind.toUpperCase()}_FOLLOWUP_OK`)

        await currentAdapter.sendInput(
          currentHandle,
          `Immediately run the shell command sleep 20. When it finishes, reply with exactly E2E_${kind.toUpperCase()}_STEERING_BASE_OK.`,
        )
        await waitForPane(currentAdapter, currentHandle, runningMarker, 25_000)
        await currentAdapter.sendInput(
          currentHandle,
          `After the current command, also include exactly E2E_${kind.toUpperCase()}_STEERING_OK in your response.`,
        )
        await waitForState(currentAdapter, currentHandle, 'idle', 60_000)
        await waitForPane(currentAdapter, currentHandle, `E2E_${kind.toUpperCase()}_STEERING_OK`, 60_000)

        // Recreate only the adapter process. The tmux pane and its native session stay alive.
        await currentAdapter.dispose()
        currentAdapter = kind === 'claude'
          ? new ClaudeCodeAdapter({
            dataDir: join(dataDir, 'adapter-data'),
            claudeBin: CLAUDE_BIN,
            pasteReadyTimeoutMs: 20_000,
          })
          : new CodexWorkerAdapter({
            dataDir: join(dataDir, 'adapter-data'),
            codexBin: CODEX_BIN,
            codexHomeSource: join(os.homedir(), '.codex'),
            pasteReadyTimeoutMs: 20_000,
            sessionDiscoveryTimeoutMs: 20_000,
          })
        expect(await currentAdapter.state(currentHandle)).toBe('idle')
        await currentAdapter.sendInput(currentHandle, `Reply with exactly E2E_${kind.toUpperCase()}_REATTACH_OK. Do not edit files.`)
        await waitForState(currentAdapter, currentHandle, 'idle')
        await waitForPane(currentAdapter, currentHandle, `E2E_${kind.toUpperCase()}_REATTACH_OK`)

        await currentAdapter.sendInput(
          currentHandle,
          `Immediately run the shell command sleep 45. Do not respond before the command ends.`,
        )
        await waitForPane(currentAdapter, currentHandle, runningMarker, 25_000)
        const interruptedAt = Date.now()
        await currentAdapter.interrupt(currentHandle)
        await waitForState(currentAdapter, currentHandle, 'idle', 10_000)
        expect(Date.now() - interruptedAt).toBeLessThan(10_000)

        await currentAdapter.sendInput(
          currentHandle,
          `Immediately run the shell command sleep 60. Do not respond before the command ends.`,
        )
        await waitForPane(currentAdapter, currentHandle, runningMarker, 25_000)
        await currentAdapter.stop(currentHandle)
        await waitForState(currentAdapter, currentHandle, 'exited', 10_000)
        expect(await tmux.isAlive(`crabot-w-${currentHandle.worker_id}-${currentHandle.seq}`)).toBe(false)
      } finally {
        await finish(currentAdapter, currentHandle, dataDir)
        await fs.rm(workspace, { recursive: true, force: true }).catch(() => {})
      }
    }, 240_000)

    it(`${kind}: adapter restart reattaches the real tmux pane`, async () => {
      const { adapter, dataDir, handle } = await setup(kind)
      let active = adapter
      try {
        expect(handle.initial_input?.disposition).toBe('accepted')
        await waitForState(active, handle, 'idle', 90_000)
        await active.dispose()
        active = recreateAdapter(kind, dataDir)
        expect(await active.state(handle)).toBe('idle')
        await active.sendInput(handle, `Reply with exactly E2E_${kind.toUpperCase()}_REATTACH_ONLY_OK. Do not edit files.`)
        await waitForState(active, handle, 'idle', 90_000)
        await waitForPane(active, handle, `E2E_${kind.toUpperCase()}_REATTACH_ONLY_OK`, 90_000)
      } finally {
        await finish(active, handle, dataDir)
      }
    }, 120_000)

    it(`${kind}: resume sends a real primary input to the native session`, async () => {
      const { adapter, dataDir, handle } = await setup(kind)
      let active = adapter
      let resumed = handle
      try {
        expect(handle.initial_input?.disposition).toBe('accepted')
        await waitForState(active, handle, 'idle')
        await active.stop(handle)
        await waitForState(active, handle, 'exited')
        resumed = await active.resume(handle, `Reply with exactly E2E_${kind.toUpperCase()}_RESUME_OK. Do not edit files.`)
        expect(resumed.initial_input?.disposition).toBe('accepted')
        await waitForState(active, resumed, 'idle', 60_000)
        await waitForPane(active, resumed, `E2E_${kind.toUpperCase()}_RESUME_OK`, 60_000)
      } finally {
        await finish(active, resumed, dataDir)
      }
    }, 180_000)

    it(`${kind}: stop closes a real running tmux worker`, async () => {
      const { adapter, dataDir, handle } = await setup(kind)
      const runningMarker = kind === 'claude' ? 'esc to interrupt' : 'Working'
      try {
        expect(handle.initial_input?.disposition).toBe('accepted')
        await waitForState(adapter, handle, 'idle')
        await adapter.sendInput(handle, 'Immediately run the shell command sleep 60. Do not respond before it ends.')
        await waitForPane(adapter, handle, runningMarker, 25_000)
        await adapter.stop(handle)
        await waitForState(adapter, handle, 'exited', 10_000)
        expect(await tmux.isAlive(`crabot-w-${handle.worker_id}-${handle.seq}`)).toBe(false)
      } finally {
        await finish(adapter, handle, dataDir)
      }
    }, 120_000)

    it(`${kind}: interrupt settles a real running worker`, async () => {
      const { adapter, dataDir, handle } = await setup(kind)
      const runningMarker = kind === 'claude' ? 'esc to interrupt' : 'Working'
      try {
        expect(handle.initial_input?.disposition).toBe('accepted')
        await waitForState(adapter, handle, 'idle')
        await adapter.sendInput(handle, 'Immediately run the shell command sleep 45. Do not respond before it ends.')
        await waitForPane(adapter, handle, runningMarker, 25_000)
        const started = Date.now()
        await adapter.interrupt(handle)
        await waitForState(adapter, handle, 'idle', 10_000)
        expect(Date.now() - started).toBeLessThan(10_000)
      } finally {
        await finish(adapter, handle, dataDir)
      }
    }, 120_000)
  }

  it('claude: real plan mode automatically switches to auto and executes', async () => {
    const { adapter, workspace, dataDir, handle } = await setup('claude', {
      claudeBinFactory: writeClaudePlanWrapper,
      prompt: 'Create a concise plan to write plan-mode-result.txt containing exactly plan_mode_done. When the plan is ready, proceed with the file creation.',
    })
    try {
      expect(handle.initial_input?.disposition).toBe('accepted')
      try {
        await waitFor(
          async () => (await fs.readFile(join(workspace, 'plan-mode-result.txt'), 'utf-8').catch(() => '')) === 'plan_mode_done',
          'Claude plan-mode execution',
          90_000,
        )
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n` +
          `--- terminal ---\n${await paneText(adapter, handle)}\n` +
          `--- hook events ---\n${await cliEventsText(workspace, 'claude')}`,
        )
      }
      await waitForState(adapter, handle, 'idle', 60_000)
      await waitForPane(adapter, handle, 'auto mode on', 30_000)
    } finally {
      await finish(adapter, handle, dataDir)
    }
  }, 180_000)

  for (const kind of ['claude', 'codex'] as const) {
    it(`${kind}: harness interrupt settles and permits a follow-up`, async () => {
      const test = await setupHarnessWorker(kind)
      const runningMarker = kind === 'claude' ? 'esc to interrupt' : 'Working'
      try {
        await waitFor(async () => (await test.harness.findWorker(test.workerId))?.worker.incarnations[0]?.state === 'idle', 'initial worker idle', 60_000)
        await test.harness.sendToWorker(test.workerId, 'Immediately run the shell command sleep 45. Do not respond before it ends.')
        await waitFor(async () => terminalContains(test.harness, test.workerId, runningMarker), 'running worker pane', 25_000)
        const operation = await test.harness.requestWorkerInterrupt(test.workerId)
        expect(operation.status).toBe('succeeded')
        await waitFor(async () => {
          const events = await test.harness.readWorkerEvents(test.workerId)
          return events.some((event) => event.kind === 'operation_settled' && event.detail?.operation_id === operation.operation_id && event.detail?.status === 'succeeded')
        }, 'interrupt settlement event', 10_000)
        await test.harness.sendToWorker(test.workerId, `Reply with exactly E2E_${kind.toUpperCase()}_INTERRUPT_FOLLOWUP_OK. Do not edit files.`)
        try {
          await waitFor(
            async () => terminalContains(test.harness, test.workerId, `E2E_${kind.toUpperCase()}_INTERRUPT_FOLLOWUP_OK`),
            'interrupt follow-up',
            60_000,
          )
        } catch (error) {
          const terminal = await test.harness.getWorkerTerminal(test.workerId)
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n` +
            `--- terminal ---\n${terminal.kind === 'unavailable' ? terminal.unavailable_reason : terminal.text}\n` +
            `--- hook events ---\n${await cliEventsText(test.workspace, kind)}\n` +
            `--- harness events ---\n${JSON.stringify(test.events, null, 2)}`,
          )
        }
      } finally {
        await cleanupHarnessPermissionWorker(test)
      }
    }, 180_000)

    it(`${kind}: real permission UI is answered through one snapshot action`, async () => {
      const test = await setupHarnessPermissionWorker(kind)
      try {
        let snapshotId: string | undefined
        try {
          await waitFor(async () => {
            const event = test.events.find((candidate) => typeof candidate.detail?.snapshot_id === 'string')
            snapshotId = event?.detail?.snapshot_id as string | undefined
            return snapshotId !== undefined
          }, 'permission snapshot', 60_000)
        } catch (error) {
          const terminal = await test.harness.getWorkerTerminal(test.workerId)
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n` +
            `--- terminal ---\n${terminal.kind === 'unavailable' ? terminal.unavailable_reason : terminal.text}\n` +
            `--- hook events ---\n${await cliEventsText(test.workspace, kind)}\n` +
            `--- harness events ---\n${JSON.stringify(test.events, null, 2)}`,
          )
        }
        const result = await test.harness.respondToWorkerUi(test.workerId, snapshotId!, 'confirm')
        expect(result.status).toBe('submitted')
        await waitFor(async () => (await fs.readFile(test.permissionFile!, 'utf-8').catch(() => '')) === 'approved', 'approved file', 60_000)
        expect((await test.harness.requestWorkerStop(test.workerId)).status).toBe('succeeded')
      } finally {
        await cleanupHarnessPermissionWorker(test)
      }
    }, 180_000)
  }
})
