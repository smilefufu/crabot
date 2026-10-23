// Native Ubuntu bootstrap only; never starts business services or runs sudo.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.resolve(process.argv[2] || '')
if (process.platform !== 'linux' || process.arch !== 'x64' || process.argv.length !== 3
  || !path.relative(path.join(root, '.desktop-build'), output).match(/^(?!\.\.(?:\/|$))[^/].*/)) throw new Error('Expected Linux x64 build output under .desktop-build')
const os = await fs.readFile('/etc/os-release', 'utf8')
if (!/^ID=ubuntu$/m.test(os) || !/^VERSION_ID="24\.04"$/m.test(os)) throw new Error('Shipping bootstrap requires the Ubuntu24.04 ABI baseline')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Native bootstrap requires clean source')
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.mkdir(output)
const source = path.join(root, 'crabot-desktop/native/ubuntu')
const flags = packages => execFileSync('/usr/bin/pkg-config', ['--cflags', '--libs', ...packages], { encoding: 'utf8' }).trim().split(/\s+/)
for (const [name, file, packages] of [
  ['crabot-sandbox-helper', 'sandbox-helper.c', ['json-glib-1.0']],
  ['crabot-installer', 'installer.c', ['gtk4', 'json-glib-1.0']],
]) {
  execFileSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-D_FORTIFY_SOURCE=3', '-fstack-protector-strong',
    '-Wl,-z,relro,-z,now', path.join(source, file), '-o', path.join(output, name), ...flags(packages)], { stdio: 'inherit' })
}

const files = {}
for (const name of ['crabot-installer', 'crabot-sandbox-helper']) {
  const bytes = await fs.readFile(path.join(output, name))
  files[name] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
await fs.writeFile(path.join(output, 'native-bootstrap.json'), JSON.stringify({ schema_version: 1, platform: 'linux', arch: 'x64',
  build_os: 'ubuntu-24.04', commit, source_dirty: false, files }) + '\n', { flag: 'wx' })
