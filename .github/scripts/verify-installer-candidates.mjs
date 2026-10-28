// Extract candidate distribution containers and verify the complete Core, ASAR entries and executable fuses.
// No installation, GUI, service, registration or user-data mutation is performed.
import assert from 'node:assert/strict'
import { promises as fs, createReadStream } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runBounded } from '../../scripts/lib/run-bounded.mjs'
import { verifyCoreRelease } from '../../scripts/lib/core-release.mjs'
import { verifyDesktopAsar } from '../../scripts/lib/desktop-asar.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const directory = await fs.realpath(path.resolve(process.argv[2]))
const report = JSON.parse(await fs.readFile(path.join(directory, 'installers.json'), 'utf8'))
assert.equal(report.schema_version, 1); assert.equal(report.candidate_only, true); assert.equal(report.release_signed, false)
assert.equal(report.platform, process.platform); assert.equal(report.arch, process.arch)
const extensions = process.platform === 'darwin' ? ['.dmg', '.zip'] : process.platform === 'win32' ? ['.exe'] : ['.deb']
assert.equal(report.files.length, extensions.length)
for (const extension of extensions) assert.equal(report.files.filter(file => path.extname(file.file) === extension).length, 1)
const require = createRequire(path.join(repository, 'crabot-desktop/package.json'))
const builderRequire = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
let sevenZip
if (process.platform === 'win32') {
  assert.ok(process.env.ProgramFiles, 'Windows container verification requires the full 7-Zip build-host tool')
  sevenZip = path.join(process.env.ProgramFiles, '7-Zip', '7z.exe')
  assert.equal((await fs.stat(sevenZip)).isFile(), true)
}
async function hash(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'Crabot Installer '))
let retainTemporary = false
try {
  for (const item of report.files) {
    assert.equal(path.basename(item.file), item.file)
    const file = path.join(directory, item.file)
    assert.equal((await fs.stat(file)).size, item.bytes)
    assert.equal(await hash(file), item.sha256)
    const output = path.join(temporary, path.extname(file).slice(1)); await fs.mkdir(output)
    let application, mounted = false
    try {
      if (file.endsWith('.dmg')) {
        await runBounded('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', output, file])
        mounted = true; application = path.join(output, 'Crabot.app/Contents')
      } else if (file.endsWith('.zip')) {
        await runBounded('/usr/bin/ditto', ['-x', '-k', file, output])
        application = path.join(output, 'Crabot.app/Contents')
      } else if (file.endsWith('.deb')) {
        await runBounded('/usr/bin/dpkg-deb', ['--extract', file, output])
        application = path.join(output, 'opt/Crabot')
      } else {
        await runBounded(sevenZip, ['x', '-tNsis', file, '-o' + output, '-y'])
        const embedded = path.join(output, '$PLUGINSDIR/app-64.7z')
        assert.equal((await fs.lstat(embedded)).isFile(), true)
        application = path.join(output, 'app')
        await runBounded(sevenZip, ['x', '-t7z', embedded, '-o' + application, '-y'])
      }
      const resources = path.join(application, process.platform === 'darwin' ? 'Resources' : 'resources')
      const candidate = JSON.parse(await fs.readFile(path.join(resources, 'candidate-only.json'), 'utf8'))
      assert.equal(candidate.candidate_only, true); assert.equal(candidate.inventory_sha256, report.inventory_sha256)
      const core = path.join(resources, 'core'), release = await verifyCoreRelease(core, { version: report.version })
      assert.equal(release.inventory_sha256, report.inventory_sha256)
      const host = JSON.parse(await fs.readFile(path.join(core, 'desktop-host.json'), 'utf8'))
      assert.equal(host.platform, process.platform); assert.equal(host.arch, process.arch)
      assert.match(report.app.asar_sha256, /^[a-f0-9]{64}$/)
      assert.equal(await hash(path.join(resources, 'app.asar')), report.app.asar_sha256)
      const asar = builderRequire('@electron/asar')
      verifyDesktopAsar(asar, path.join(resources, 'app.asar'))
      const executable = path.join(application, process.platform === 'darwin' ? 'MacOS/Crabot' : process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
      assert.match(report.app.executable_sha256, /^[a-f0-9]{64}$/)
      assert.equal(await hash(executable), report.app.executable_sha256)
      const { getCurrentFuseWire, FuseV1Options } = builderRequire('@electron/fuses')
      const fuses = await getCurrentFuseWire(executable)
      for (const key of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments]) assert.equal(fuses[key], 48)
      assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], 49)
      console.log('CRABOT_INSTALLER_VERIFIED ' + JSON.stringify({ file: item.file, container_extracted: true,
        core_inventory: true, app_bytes: true, asar: true, fuses: true, candidate_only: true, installed: false, release_signed: false }))
    } finally {
      if (mounted) {
        try { await runBounded('/usr/bin/hdiutil', ['detach', output]) }
        catch (error) { retainTemporary = true; throw error }
      }
      await fs.rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
} finally { if (!retainTemporary) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
