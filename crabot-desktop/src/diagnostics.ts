import { arch, release } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DesktopDiagnosticsSchema, type DesktopDiagnostics, type DesktopHostState } from 'crabot-client'

export async function collectDiagnostics(coreRoot: string, state: DesktopHostState, recent: DesktopDiagnostics['recent']): Promise<DesktopDiagnostics> {
  const load = async (file: string) => (await import(pathToFileURL(path.join(coreRoot, 'scripts/lib', file)).href)).default
  const versions: Record<string, string> = { electron: process.versions.electron ?? 'unknown', host_node: process.versions.node }
  let runtimeStatus: 'entry_checked' | 'unavailable' = 'unavailable'
  try {
    const runtime = (await load('product-runtime.cjs')).loadProductRuntime(coreRoot, { required: true })
    for (const key of ['node', 'python', 'uv', 'rg', 'git', 'bash']) {
      const version = runtime.manifest.versions[key]
      if (typeof version === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(version)) versions[key] = version
    }
    runtimeStatus = 'entry_checked'
  } catch { /* No host-interpreter fallback, installer, subprocess or raw error content. */ }
  const resources: DesktopDiagnostics['resources'] = []
  for (const [name, file] of [['browser', 'scrapling-runtime.cjs'], ['computer_use', 'computer-use-runtime.cjs']] as const) {
    let status: 'entry_checked' | 'unavailable' = 'unavailable'
    try { (await load(file)).loadRuntime(coreRoot); status = 'entry_checked' } catch { /* read-only resource check */ }
    resources.push({ name, status })
  }
  let nativeStatus: 'entry_checked' | 'unavailable' = 'unavailable'
  try { if ((await load('process-identity.cjs')).inspectProcess(process.pid)?.pid === process.pid) nativeStatus = 'entry_checked' } catch { /* no OS permission prompt */ }
  resources.push({ name: 'native_helper', status: nativeStatus })
  const safeState = { ...state }
  if ('message' in safeState) delete safeState.message
  return DesktopDiagnosticsSchema.parse({ schema_version: 1, report_id: randomUUID(), created_at: new Date().toISOString(),
    system: { platform: process.platform, arch: arch(), os_release: release() }, state: safeState,
    runtime: { status: runtimeStatus, versions }, resources, recent: recent.slice(-40) })
}
