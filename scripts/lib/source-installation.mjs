// Read-only classification for independent installation, never takeover/auth authority.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname, delimiter, resolve } from 'node:path'
import { homedir } from 'node:os'

export function discoverUserSourceDeployment({ home = homedir(), source = process.env } = {}) {
  const original = join(home, '.crabot')
  // An actual old release at the data root takes priority over unrelated source commands.
  if (existsSync(join(original, 'VERSION')) && existsSync(join(original, 'cli.mjs')) && !existsSync(join(original, '.git'))) return null
  const candidates = [original]
  const entries = [join(home, '.local/bin/crabot')]
  for (const directory of (source.PATH || source.Path || '').split(delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32' ? ['crabot.cmd', 'crabot.exe', 'crabot.ps1'] : ['crabot']) entries.push(join(directory, name))
  }
  for (const entry of entries) {
    try {
      const target = realpathSync(entry), directory = dirname(target)
      candidates.push(directory)
      if (dirname(directory) !== directory && directory.endsWith('bin')) candidates.push(dirname(directory))
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error }
  }
  const runtime = join(home, '.crabot/data/instance-runtime.json')
  try {
    const value = JSON.parse(readFileSync(runtime, 'utf8'))
    if (typeof value.install_root === 'string' && value.install_root === resolve(value.install_root)) candidates.push(value.install_root)
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  for (const directory of new Set(candidates)) {
    if (!existsSync(join(directory, '.git')) || !existsSync(join(directory, 'cli.mjs'))) continue
    try {
      if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name === 'crabot') return { root: realpathSync(directory) }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }
  return null
}
