// Ordinary CLI candidate archive, byte-identical to the verified shared Core.
// Does not sign, publish or modify the source. Round-trip verification is required.
import { promises as fs, createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { runBounded } from '../lib/run-bounded.mjs'
import { verifyCoreRelease } from '../lib/core-release.mjs'
import { stageRelease } from '../upgrade-lib/release.mjs'
import product from '../lib/product-runtime.cjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const options = new Map(process.argv.slice(2).map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)] }))
if (options.get('--candidate') !== 'true' || !options.get('--core') || !options.get('--out')) throw new Error('Expected --candidate=true --core=<sealed-core> --out=<new-candidate-directory>')
const root = await fs.realpath(path.resolve(options.get('--core')))
const requestedOutput = path.resolve(options.get('--out'))
const buildRoot = await fs.realpath(path.join(repository, '.desktop-build'))
const output = path.join(await fs.realpath(path.dirname(requestedOutput)), path.basename(requestedOutput))
const buildRelative = path.relative(buildRoot, output), coreRelative = path.relative(root, output)
const inside = relative => !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
if (!buildRelative || !inside(buildRelative)) throw new Error('Candidate archive must be under .desktop-build')
if (inside(coreRelative)) throw new Error('Archive output cannot be inside the Core')
const release = await verifyCoreRelease(root)
if (release.source_dirty || await fs.stat(path.join(root, 'desktop-host.json')).catch(() => null)) throw new Error('Archive only a clean shared Core, not an App-owned copy')
const runtime = product.loadProductRuntime(root, { required: true, full: true })
const windows = process.platform === 'win32'
const index = JSON.parse(await fs.readFile(path.join(root, 'core-files.json'), 'utf8'))
if (windows && Object.values(index.files).some(file => file.type === 'link')) throw new Error('Windows ordinary ZIP requires a materialized payload without symlinks')
const size = Object.values(index.files).reduce((sum, file) => sum + BigInt(file.size ?? 0), 0n)
const space = await fs.statfs(path.dirname(output), { bigint: true })
if (space.bavail * space.bsize < size * 2n + 64n * 1024n * 1024n) throw new Error('CLI archive and round-trip verification need more temporary disk space')
await fs.mkdir(output) // Never replace a previous candidate or its evidence.
const file = `crabot-v${release.version}-${windows ? 'windows' : process.platform}-${process.arch}-candidate.${windows ? 'zip' : 'tar.gz'}`
const archive = path.join(output, file), partial = archive + '.partial'
const script = `import os,sys,tarfile,zipfile
root,destination,kind=sys.argv[1:]
if kind=='zip':
 with zipfile.ZipFile(destination,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
  z.write(root,'crabot-core')
  for directory,dirs,files in os.walk(root):
   dirs.sort();files.sort()
   for name in dirs+files:
    full=os.path.join(directory,name)
    z.write(full,'crabot-core/'+os.path.relpath(full,root).replace(os.sep,'/'))
else:
 with tarfile.open(destination,'w:gz',compresslevel=6) as t:
  t.add(root,arcname='crabot-core',recursive=True)
`
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_.*)$/i.test(key)))
  await runBounded(runtime.executables.python, ['-I', '-X', 'utf8', '-B', '-c', script, root, partial, windows ? 'zip' : 'tar'], { env, timeout: 20 * 60_000 })
  await fs.rename(partial, archive)
  const extracted = await stageRelease({ tmp: output, tarPath: archive, version: 'v' + release.version })
  const restored = JSON.parse(await fs.readFile(path.join(extracted, 'core-release.json'), 'utf8'))
  const current = await verifyCoreRelease(root, { version: release.version })
  if (restored.inventory_sha256 !== release.inventory_sha256 || current.inventory_sha256 !== release.inventory_sha256) throw new Error('Archive/source version set changed during packaging')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  const sha256 = hash.digest('hex'), bytes = (await fs.stat(archive)).size
  await fs.writeFile(archive + '.sha256', sha256 + '  ' + file + '\n', { flag: 'wx' })
  await fs.writeFile(path.join(output, 'archive.json'), JSON.stringify({ candidate_only: true, roundtrip_verified: true, file, sha256, bytes,
    version: release.version, platform: process.platform, arch: process.arch, inventory_sha256: release.inventory_sha256 }) + '\n', { flag: 'wx' })
  console.log('CRABOT_CLI_ARCHIVE ' + JSON.stringify({ file, sha256, bytes, roundtrip_verified: true, candidate_only: true }))
} finally {
  await fs.rm(partial, { force: true })
  await fs.rm(path.join(output, 'stage'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
