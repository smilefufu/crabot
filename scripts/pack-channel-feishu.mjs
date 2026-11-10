import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Bundle only the unpublished shared runtime; platform SDK dependencies remain normal npm dependencies. */
export async function pack(destination) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'cordis-feishu-pack-'))
  try {
    await fs.mkdir(destination, { recursive: true })
    const source = path.join(repo, 'crabot-channel-feishu')
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'))
    const sharedSource = path.join(repo, 'crabot-shared')
    const shared = JSON.parse(await fs.readFile(path.join(sharedSource, 'package.json'), 'utf8'))
    manifest.dependencies = { ...manifest.dependencies, ...shared.dependencies, 'crabot-shared': shared.version }
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2))
    await fs.cp(path.join(source, 'dist'), path.join(stage, 'dist'), { recursive: true })
    await fs.copyFile(path.join(source, 'crabot-module.yaml'), path.join(stage, 'crabot-module.yaml'))
    const sharedTarget = path.join(stage, 'node_modules/crabot-shared')
    await fs.mkdir(sharedTarget, { recursive: true })
    await fs.writeFile(path.join(sharedTarget, 'package.json'), JSON.stringify(shared, null, 2))
    await fs.cp(path.join(sharedSource, 'dist'), path.join(sharedTarget, 'dist'), { recursive: true })
    const result = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', path.resolve(destination)], {
      cwd: stage,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
      maxBuffer: 4 * 1024 * 1024,
    })
    const [{ files, ...summary }] = JSON.parse(result.stdout)
    if (files.some(file => file.path.includes('/src/') || file.path.includes('.test.') || file.path.includes('.pnpm/'))) throw new Error('Development files leaked into npm artifact')
    return summary
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await pack(path.resolve(process.argv[2] ?? 'artifacts')), null, 2))
}
