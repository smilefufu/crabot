// Called only after the paired source and tracked backend were verified by the
// common offline builder. No compiler/package download runs during user install.
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { verifyDesktopPayload } from '../lib/desktop-payload.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export async function readUbuntuBootstrap(directory, commit) {
  const manifestFile = path.join(directory, 'native-bootstrap.json'), stat = await fs.lstat(manifestFile)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Invalid native manifest')
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  if (manifest.schema_version !== 1 || manifest.platform !== 'linux' || manifest.arch !== 'x64' || manifest.build_os !== 'ubuntu-24.04'
    || manifest.commit !== commit || manifest.source_dirty !== false || Object.keys(manifest.files || {}).sort().join(',') !== 'crabot-installer,crabot-sandbox-helper') throw new Error('Native source identity mismatch')
  const binaries = {}
  for (const name of ['crabot-installer', 'crabot-sandbox-helper']) {
    const stat = await fs.lstat(path.join(directory, name)), record = manifest.files[name]
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 20 || stat.size > 10 * 1024 * 1024) throw new Error('Invalid native binary')
    const bytes = await fs.readFile(path.join(directory, name))
    if (bytes.length !== record.size
      || createHash('sha256').update(bytes).digest('hex') !== record.sha256 || !bytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1]))
      || bytes.length < 20 || bytes[18] !== 62 || bytes[19] !== 0) throw new Error('Native bootstrap bytes changed')
    binaries[name] = bytes
  }
  return { manifest, binaries }
}
export async function packageUbuntuInstaller({ appDir, output, payload, release, nativeDirectory, distribute }) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !nativeDirectory) throw new Error('Expected Ubuntu24-built native bootstrap')
  if (distribute) throw new Error('Ubuntu distribution remains gated on default GNOME/Polkit and actual GUI/browser sandbox acceptance')
  const native = await fs.realpath(path.resolve(nativeDirectory)), relative = path.relative(path.join(root, '.desktop-build'), native)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Native input must be in the candidate build root')
  const { manifest, binaries } = await readUbuntuBootstrap(native, release.commit)
  const bundle = path.join(output, 'ubuntu-native')
  await fs.mkdir(bundle)
  for (const [name, bytes] of Object.entries(binaries)) await fs.writeFile(path.join(bundle, name), bytes, { flag: 'wx', mode: 0o755 })
  await fs.writeFile(path.join(bundle, 'native-bootstrap.json'), JSON.stringify(manifest) + '\n', { flag: 'wx' })
  await fs.rename(appDir, path.join(bundle, 'backend'))
  await fs.rename(path.join(output, 'crabot-client'), path.join(bundle, 'crabot-client'))
  await fs.copyFile(path.join(root, 'crabot-desktop/native/ubuntu/browser-probe.py'), path.join(bundle, 'browser-probe.py'))
  await fs.cp(payload.directory, path.join(bundle, 'offline'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await verifyDesktopPayload(path.join(bundle, 'offline'))
  await fs.writeFile(path.join(bundle, 'candidate-only.json'), JSON.stringify({ candidate_only: true, release_signed: false, version: release.version }) + '\n')
  await fs.writeFile(path.join(output, 'installer-location.json'), JSON.stringify({ schema_version: 1, candidate_only: true, release_signed: false,
    bootstrap: 'gtk4', executable: 'ubuntu-native/crabot-installer', payload: 'ubuntu-native/offline' }) + '\n')
}
