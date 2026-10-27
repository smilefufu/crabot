import fs from 'node:fs/promises'
import path from 'node:path'
import type { Workspace } from '../types.js'
import { CliEventChannel } from '../cli-events.js'
import { isWithin } from '../../permissions/tool-authorization.js'

export function nativeRuntimeRoot(workspace: Workspace): string { return workspace.runtime_root ?? workspace.root }
export function nativeEventSource(workspace: Workspace): string | undefined {
  return workspace.runtime_root ? 'crabot_cli_hook:' + path.basename(workspace.runtime_root) : undefined
}
export function nativeEventChannel(workspace: Workspace, directory: string): CliEventChannel {
  return new CliEventChannel(path.join(nativeRuntimeRoot(workspace), directory, 'events-cli.jsonl'), nativeEventSource(workspace))
}

/** Verify the host-owned execution area before any provision side effect; historical layouts retain their guards. */
export async function verifyPrivateNativeRuntime(workspace: Workspace): Promise<void> {
  if (workspace.runtime_root === undefined) return
  if (!workspace.workspace_id || !path.isAbsolute(workspace.runtime_root)) throw new Error('Private CLI runtime has no verified workspace binding')
  const project = await fs.realpath(workspace.root), runtime = await fs.realpath(workspace.runtime_root)
  const stat = await fs.lstat(workspace.runtime_root)
  if (runtime !== workspace.runtime_root || !stat.isDirectory() || stat.isSymbolicLink() || isWithin(project, runtime) || isWithin(runtime, project)) {
    throw new Error('Private CLI runtime overlaps the project or cannot be verified')
  }
  const privateDirectory = process.platform === 'win32'
    ? require('../../../../scripts/lib/process-identity.cjs').isPrivateDirectory(runtime)
    : stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o700
  if (!privateDirectory) throw new Error('Private CLI runtime permissions cannot be verified')
}

export function runtimeWorkspace(runtime: { workspaceRoot: string; runtimeRoot?: string; workspaceId?: string }): Workspace {
  return { root: runtime.workspaceRoot, workspace_id: runtime.workspaceId, runtime_root: runtime.runtimeRoot }
}

/** Metadata validation is structural: stopping an owned child must remain possible if its files disappeared. */
export function verifyNativeRuntimeMetadata(meta: { workspace_root?: unknown; workspace_id?: unknown; runtime_root?: unknown }): void {
  if (meta.workspace_id === undefined && meta.runtime_root === undefined) return
  if (typeof meta.workspace_id !== 'string' || !/^(?:default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(meta.workspace_id)
    || typeof meta.runtime_root !== 'string' || !path.isAbsolute(meta.runtime_root) || meta.runtime_root.includes('\0')
    || typeof meta.workspace_root !== 'string' || !path.isAbsolute(meta.workspace_root) || meta.workspace_root.includes('\0')) {
    throw new Error('Private CLI runtime location is missing or invalid; project fallback refused')
  }
}

export async function verifyNativeBinding(actual: Workspace, expected?: Workspace): Promise<void> {
  if (expected && (expected.runtime_root || actual.runtime_root)
    && (expected.root !== actual.root || expected.runtime_root !== actual.runtime_root || expected.workspace_id !== actual.workspace_id)) {
    throw new Error('Private CLI runtime does not match the host workspace binding')
  }
  await verifyPrivateNativeRuntime(actual)
}
