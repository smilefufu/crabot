// Disposable packaging experiment, never a release or a product installation.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.platform, 'linux')
const base = path.resolve('.desktop-build/appimage-research')
const payload = path.resolve('.desktop-build/original/ubuntu-native/offline')
const appdir = path.join(base, 'Crabot.AppDir')
const require = createRequire(path.join(base, 'tools/package.json'))
const asar = require('@electron/asar')
await fs.mkdir(appdir, { recursive: true })
await fs.cp(path.join(payload, 'gui'), appdir, { recursive: true, verbatimSymlinks: true })
const source = JSON.parse(await fs.readFile(path.join(payload, 'core/core-release.json'), 'utf8'))
const originalAsar = path.join(appdir, 'resources/app.asar')
const asarSha = createHash('sha256').update(await fs.readFile(originalAsar)).digest('hex')
const extracted = path.join(base, 'asar')
asar.extractAll(originalAsar, extracted)
// Use the already supported monolithic candidate layout. No GUI/worker source
// is changed. The existing paired-layout pin must not pretend this is installed.
await fs.unlink(path.join(extracted, 'dist/desktop-release.json'))
await fs.rm(path.join(appdir, 'resources/desktop-release.json'))
await asar.createPackageWithOptions(extracted, path.join(base, 'research.asar'), { unpack: '**/*.node' })
await fs.rename(path.join(base, 'research.asar'), originalAsar)
await fs.cp(path.join(payload, 'core'), path.join(appdir, 'resources/core'), { recursive: true, verbatimSymlinks: true })
await fs.writeFile(path.join(appdir, 'resources/core/desktop-host.json'), JSON.stringify({ schema_version: 1, platform: 'linux', arch: 'x64' }) + '\n')
await fs.writeFile(path.join(appdir, 'crabot.desktop'), '[Desktop Entry]\nType=Application\nName=Crabot Research\nExec=crabot-desktop\nIcon=crabot\nCategories=Utility;\n')
await fs.copyFile('crabot-desktop/assets/app.png', path.join(appdir, 'crabot.png'))
if (process.argv.includes('--layout-only')) process.exit(0)
await fs.writeFile(path.join(appdir, 'AppRun'), `#!/bin/sh
set -eu
printf 'CRABOT_RESEARCH_MOUNT=%s\\n' "$APPDIR"
# Research-only pause lets CI grant exact-path permission before exec. The
# unmodified-system baseline never sets this variable and does not wait.
if [ "\u0024{CRABOT_RESEARCH_GATE:-}" = yes ]; then
  IFS= read -r gate
  [ "$gate" = continue ] || exit 42
fi
exec "$APPDIR/crabot-desktop" "$@"
`, { mode: 0o755 })
const squash = path.join(base, 'payload.squashfs')
execFileSync('/usr/bin/mksquashfs', [appdir, squash, '-noappend', '-no-xattrs', '-comp', 'zstd', '-Xcompression-level', '5', '-processors', '2'], { stdio: 'inherit' })
const runtime = await fs.readFile(path.join(base, 'runtime-x86_64'))
assert.equal(createHash('sha256').update(runtime).digest('hex'), '617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46')
const image = path.join(base, 'Crabot-research.AppImage')
await fs.writeFile(image, Buffer.concat([runtime, await fs.readFile(squash)]), { mode: 0o755 })
const report = { research_only: true, source_run: 41405225245, source_commit: source.commit, source_version: source.version,
  original_asar_sha256: asarSha, prototype_layout: 'existing monolithic resources/core', product_source_changed: false,
  packaging_changes: ['remove paired installation pin from ASAR/resources', 'embed unchanged Core with existing schema1 desktop host marker', 'research-only AppRun observation gate'],
  runtime_asset_id: 657374641, runtime_sha256: createHash('sha256').update(runtime).digest('hex'),
  image_sha256: createHash('sha256').update(await fs.readFile(image)).digest('hex'), image_bytes: (await fs.stat(image)).size }
await fs.writeFile(path.join(base, 'packaging.json'), JSON.stringify(report, null, 2) + '\n')
console.log('CRABOT_APPIMAGE_PACKAGING ' + JSON.stringify(report))
