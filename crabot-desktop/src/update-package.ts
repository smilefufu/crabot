import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'crabot-client'
import type { UpdateDownload } from './update-dialog.js'

const channel = 'https://github.com/smilefufu/crabot/releases/latest/download'
export const UpdateConfigSchema = z.strictObject({ provider: z.literal('generic'), url: z.literal(channel),
  updaterCacheDirName: z.literal('crabot-updater'), publisherName: z.array(z.string().min(1).max(256)).min(1).optional() })
export const UpdateInfoSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
  files: z.array(z.object({ url: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]+\.(?:zip|dmg|exe|deb)$/),
    sha512: z.string().refine(value => Buffer.from(value, 'base64').length === 64 && Buffer.from(value, 'base64').toString('base64') === value),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })).min(1).max(8) })

export async function verifyUpdateDownload(update: UpdateDownload) {
  const stat = await lstat(update.file)
  if (!stat.isFile() || stat.size !== update.size) throw new Error('Update package changed')
  const digest = createHash('sha512')
  for await (const bytes of createReadStream(update.file)) digest.update(bytes)
  if (digest.digest('base64') !== update.sha512) throw new Error('Update package changed')
}
