import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import native from '../../scripts/lib/process-identity.cjs'

if (process.platform !== 'win32') throw new Error('Windows-only finite fixture')
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-cli-acl-probe-')))
try {
  await fs.rmdir(root); native.createPrivateDirectory(root)
  const child = path.join(root, 'nested'), file = path.join(child, 'config.toml'), explicit = path.join(child, 'explicit.toml')
  await fs.mkdir(child, { recursive: true, mode: 0o700 })
  await fs.writeFile(file + '.tmp', 'fixture', { mode: 0o600 })
  await fs.rename(file + '.tmp', file)
  native.writePrivateFile(explicit, 'fixture')
  console.log(JSON.stringify({ native: { root_private: native.isPrivateDirectory(root),
    child_owner_only: native.isOwnerOnlyDirectory(child), file_owner_only: native.isOwnerOnlyFile(file),
    file_private: native.isPrivateFile(file), explicit_private: native.isPrivateFile(explicit) } }))
  process.stdout.write(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('.github/scripts/windows-cli-acl-probe.ps1'), root, child, file, explicit], { encoding: 'utf8', timeout: 10000, windowsHide: true }))
} finally { await fs.rm(root, { recursive: true, force: true }) }
