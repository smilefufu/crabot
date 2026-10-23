// Native Ubuntu bootstrap only; never starts business services or runs sudo.
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.resolve(process.argv[2] || '')
if (process.platform !== 'linux' || process.arch !== 'x64' || process.argv.length !== 3
  || !path.relative(path.join(root, '.desktop-build'), output).match(/^(?!\.\.(?:\/|$))[^/].*/)) throw new Error('Expected Linux x64 build output under .desktop-build')
await fs.mkdir(output, { recursive: true })
const source = path.join(root, 'crabot-desktop/native/ubuntu')
const flags = packages => execFileSync('/usr/bin/pkg-config', ['--cflags', '--libs', ...packages], { encoding: 'utf8' }).trim().split(/\s+/)
for (const [name, file, packages] of [
  ['crabot-sandbox-helper', 'sandbox-helper.c', ['json-glib-1.0']],
  ['crabot-installer', 'installer.c', ['gtk4', 'json-glib-1.0']],
]) {
  execFileSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-D_FORTIFY_SOURCE=3', '-fstack-protector-strong',
    '-Wl,-z,relro,-z,now', path.join(source, file), '-o', path.join(output, name), ...flags(packages)], { stdio: 'inherit' })
}
