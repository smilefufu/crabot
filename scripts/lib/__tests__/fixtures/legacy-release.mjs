import { promises as fs } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { legacyReleaseFiles } from '../../legacy-release-files.mjs'

const sample = JSON.parse(gunzipSync(await fs.readFile(new URL('./legacy-release-entries.json.gz', import.meta.url)), { maxOutputLength: 2 * 1024 * 1024 }))
const catalog = JSON.parse(await fs.readFile(new URL('../../../desktop/legacy-releases.json', import.meta.url), 'utf8'))
export async function materializeLegacyRelease(root, version = 'v2026.10.15.1') {
  if (sample.schema_version !== 1 || !catalog.versions.includes(version)) throw new Error('Invalid legacy fixture')
  const originals = Object.create(null)
  for (const [name, expected] of Object.entries(legacyReleaseFiles(catalog, version))) {
    const bytes = Buffer.from((sample.platform_files?.[process.platform]?.[name] ?? sample.versions[version].files[name]), 'base64')
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Legacy fixture does not match the published fingerprint')
    const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, bytes, { mode: name === 'cli.mjs' ? 0o755 : 0o644 })
    if (process.platform !== 'win32') await fs.chmod(file, name === 'cli.mjs' ? 0o755 : 0o644)
    originals[name] = bytes
  }
  await fs.writeFile(path.join(root, 'VERSION'), version + '\n')
  return originals
}
