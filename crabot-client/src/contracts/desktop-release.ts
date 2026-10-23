import { z } from 'zod'

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
export const DesktopReleaseSelectionSchema = z.strictObject({
  schema_version: z.literal(1),
  version: z.string().max(128).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?$/),
  gui_id: z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),
  core_id: Sha256,
})
export const DesktopReleaseManifestSchema = z.strictObject({
  schema_version: z.literal(1), app_id: z.literal('com.crabot.desktop'),
  platform: z.enum(['darwin', 'win32', 'linux']), arch: z.enum(['arm64', 'x64']),
  selection: DesktopReleaseSelectionSchema,
  artifact: z.strictObject({ file: z.string().max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:zip|tar\.gz)$/),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha256: Sha256 }),
}).refine(value => value.platform === 'darwin' || value.arch === 'x64', 'Unsupported desktop release target')
export const DesktopReleaseSignaturesSchema = z.strictObject({
  schema_version: z.literal(1),
  signatures: z.array(z.strictObject({ key_id: Sha256, signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/) })).min(1).max(4),
}).refine(value => new Set(value.signatures.map(item => item.key_id)).size === value.signatures.length, 'Duplicate signing key')
export type DesktopReleaseManifest = z.infer<typeof DesktopReleaseManifestSchema>
export type DesktopReleaseSignatures = z.infer<typeof DesktopReleaseSignaturesSchema>

export function serializeDesktopReleaseManifest(value: unknown): string {
  return JSON.stringify(DesktopReleaseManifestSchema.parse(value)) + '\n'
}
export function serializeDesktopReleaseSignatures(value: unknown): string {
  return JSON.stringify(DesktopReleaseSignaturesSchema.parse(value)) + '\n'
}
export function desktopReleaseMetadataNames(platform: DesktopReleaseManifest['platform'], arch: DesktopReleaseManifest['arch']) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch) || platform !== 'darwin' && arch !== 'x64') throw new Error('Unsupported desktop release target')
  const prefix = `crabot-desktop-${platform}-${arch}`
  return { manifest: prefix + '.manifest.json', signatures: prefix + '.signatures.json' }
}
