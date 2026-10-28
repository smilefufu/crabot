import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { sha256CanonicalJson } from 'crabot-shared'
import { version } from '../core/workspace-maintenance-files.js'
import { verifyNativeRuntimeMetadata } from './provision/native-runtime.js'
import type { IncarnationHandle } from './types.js'

export interface WorkspaceHistoryCoordinates {
  readonly before_root: string
  readonly after_root: string
  readonly verify: () => Promise<void>
}
export type WorkspaceHistoryReader = (handle: IncarnationHandle) => Promise<WorkspaceHistoryCoordinates | null>
interface NativeHistoryMetadata {
  workspace_root?: string
  workspace_id?: string
  runtime_root?: string
  codex_home?: string
  session_id?: string
  session_discovery?: 'discovered' | 'placeholder'
}
const failure = () => new Error('Native history location or original metadata is unavailable; execution was not reconstructed')
const within = (root: string, value: string) => {
  const relative = path.relative(root, value)
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

/** Coordinates only. The existing query caller retains Worker visibility and source authority. */
export async function workspaceHistoryFor(handle: IncarnationHandle, reader?: WorkspaceHistoryReader) {
  const history = await reader?.(handle)
  if (!history) return null
  if (!handle.incarnation_id || !path.isAbsolute(history.before_root) || !path.isAbsolute(history.after_root)
    || history.before_root.includes('\0') || history.after_root.includes('\0')
    || path.normalize(history.before_root) !== history.before_root || path.normalize(history.after_root) !== history.after_root) throw failure()
  await history.verify()
  return history
}

/** Original meta is observed, never repaired or rebound to a new executable runtime. */
export async function nativeHistorySource(handle: IncarnationHandle, reader: WorkspaceHistoryReader | undefined,
  readMetadata: () => Promise<NativeHistoryMetadata | undefined>) {
  const history = await workspaceHistoryFor(handle, reader)
  if (!history) return null
  const metadata = await readMetadata()
  if (!metadata || metadata.workspace_root !== history.before_root || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(handle.session_ref)
    || (metadata.session_id ?? handle.session_ref) !== handle.session_ref) throw failure()
  verifyNativeRuntimeMetadata(metadata)
  const originalHash = sha256CanonicalJson(metadata)
  const verify = async () => {
    await history.verify()
    const current = await readMetadata()
    if (!current || sha256CanonicalJson(current) !== originalHash) throw failure()
    await history.verify()
  }
  await verify()
  return { metadata, history, verify }
}

export function relocatedNativePath(history: WorkspaceHistoryCoordinates, original: string): string {
  if (!path.isAbsolute(original) || original.includes('\0') || path.normalize(original) !== original) throw failure()
  return within(history.before_root, original) ? path.join(history.after_root, path.relative(history.before_root, original)) : original
}

export type NativeHistorySource = NonNullable<Awaited<ReturnType<typeof nativeHistorySource>>>

export async function nativeHistoryDirectory(source: NativeHistorySource, original: string): Promise<string> {
  await source.verify()
  const directory = relocatedNativePath(source.history, original), canonical = await fs.realpath(directory)
  if (within(source.history.before_root, original) && (!within(source.history.after_root, canonical) || await fs.realpath(source.history.after_root) !== source.history.after_root)) throw failure()
  if (!(await fs.stat(canonical)).isDirectory()) throw failure()
  await source.verify()
  return directory
}

export function nativeHistorySourcePath(history: WorkspaceHistoryCoordinates, originalDirectory: string, currentFile: string): string {
  const currentDirectory = relocatedNativePath(history, originalDirectory)
  if (!within(currentDirectory, currentFile)) throw failure()
  return path.join(originalDirectory, path.relative(currentDirectory, currentFile))
}

/** Read one original native source. This cannot launch, provision, restore, watch or mutate a CLI. */
export async function readNativeHistoryText(source: NativeHistorySource, original: string): Promise<string> {
  await source.verify()
  const file = relocatedNativePath(source.history, original), canonical = await fs.realpath(file)
  if (within(source.history.before_root, original) && (!within(source.history.after_root, canonical) || await fs.realpath(source.history.after_root) !== source.history.after_root)) throw failure()
  const before = await fs.lstat(canonical, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw failure()
  const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (version(await handle.stat({ bigint: true })) !== version(before) || await fs.realpath(file) !== canonical) throw failure()
    await source.verify()
    if (await fs.realpath(file) !== canonical || version(await fs.lstat(canonical, { bigint: true })) !== version(before)) throw failure()
    const body = await handle.readFile('utf8')
    if (version(await handle.stat({ bigint: true })) !== version(before)
      || version(await fs.lstat(canonical, { bigint: true })) !== version(before) || await fs.realpath(file) !== canonical) throw failure()
    await source.verify()
    return body
  } finally { await handle.close() }
}
