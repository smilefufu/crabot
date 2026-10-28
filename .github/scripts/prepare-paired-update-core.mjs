// Test producer only: never executes the copied Core or mutates its source.
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { verifyCoreRelease, writeCoreRelease } from '../../scripts/lib/core-release.mjs'
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
export async function preparePairedUpdateCore(source, target, version) {
  source = await fs.realpath(source); target = path.resolve(target)
  if (inside(source, target) || inside(target, source) || !/^\d+\.\d+\.\d+-desktop-fixture\.1$/.test(version)) throw new Error('Invalid finite paired-update target')
  const release = await verifyCoreRelease(source)
  await fs.mkdir(target)
  await fs.cp(source, target, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await verifyCoreRelease(target)
  for (const file of ['package.json', 'product-runtime.json']) {
    const value = JSON.parse(await fs.readFile(path.join(target, file), 'utf8')); value.version = version
    await fs.writeFile(path.join(target, file), JSON.stringify(value) + '\n')
  }
  // Only our fresh, fully verified copy is resealed. The source and the
  // immutable writer's exclusive-create rule remain untouched.
  for (const file of ['core-files.json', 'core-release.json']) await fs.unlink(path.join(target, file))
  await writeCoreRelease(target, { schema_version: 1, version, platform: release.platform, arch: release.arch, commit: release.commit, source_dirty: false })
  return verifyCoreRelease(target, { version })
}
