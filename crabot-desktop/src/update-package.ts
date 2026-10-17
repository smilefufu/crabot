import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'crabot-client'
import type { UpdateDownload } from './update-dialog.js'

export type UpdateFailure = 'space' | 'integrity' | 'signature' | 'metadata' | 'unavailable'
export function updateFailure(error: unknown): UpdateFailure {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : ''
  if (['CRABOT_UPDATE_SPACE', 'CRABOT_BACKUP_SPACE', 'ENOSPC'].includes(code)) return 'space'
  if (['CRABOT_UPDATE_INTEGRITY', 'ERR_UPDATER_CHECKSUM_MISMATCH'].includes(code)) return 'integrity'
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') return 'signature'
  if (error instanceof z.ZodError || ['ERR_UPDATER_INVALID_UPDATE_INFO', 'ERR_UPDATER_INVALID_VERSION'].includes(code)) return 'metadata'
  return 'unavailable'
}

const channel = 'https://github.com/smilefufu/crabot/releases/latest/download'
export const UpdateConfigSchema = z.strictObject({ provider: z.literal('generic'), url: z.literal(channel),
  updaterCacheDirName: z.literal('crabot-updater'), publisherName: z.array(z.string().min(1).max(256)).min(1).optional() })
export const UpdateInfoSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
  files: z.array(z.object({ url: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]+\.(?:zip|dmg|exe|deb)$/),
    sha512: z.string().refine(value => Buffer.from(value, 'base64').length === 64 && Buffer.from(value, 'base64').toString('base64') === value),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })).min(1).max(8) })

export async function verifyUpdateDownload(update: UpdateDownload) {
  const invalid = () => Object.assign(new Error('Update package changed'), { code: 'CRABOT_UPDATE_INTEGRITY' })
  const stat = await lstat(update.file).catch(error => { if (error.code === 'ENOENT') throw invalid(); throw error })
  if (!stat.isFile() || stat.size !== update.size) throw invalid()
  const digest = createHash('sha512')
  for await (const bytes of createReadStream(update.file)) digest.update(bytes)
  if (digest.digest('base64') !== update.sha512) throw invalid()
}
