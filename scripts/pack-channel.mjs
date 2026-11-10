import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const platforms = ['feishu', 'wechat', 'telegram', 'dingtalk', 'slack', 'voice']

/** Bundle unpublished Shared and Slack's patched SDK; resolve other dependencies through npm. */
export async function pack(platform, destination) {
  if (!platforms.includes(platform)) throw new Error('Unknown official Channel')
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), `cordis-${platform}-pack-`))
  try {
    await fs.mkdir(destination, { recursive: true })
    const source = path.join(repo, `crabot-channel-${platform}`)
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'))
    const sharedSource = path.join(repo, 'crabot-shared')
    const shared = JSON.parse(await fs.readFile(path.join(sharedSource, 'package.json'), 'utf8'))
    manifest.dependencies = { ...shared.dependencies, ...manifest.dependencies, 'crabot-shared': shared.version }
    delete manifest.pnpm
    if (platform === 'slack') {
      const sdkSource = await fs.realpath(path.join(source, 'node_modules/@slack/socket-mode'))
      const sdk = JSON.parse(await fs.readFile(path.join(sdkSource, 'package.json'), 'utf8'))
      const code = await fs.readFile(path.join(sdkSource, 'dist/src/SocketModeClient.js'), 'utf8')
      if (!code.includes('cb.apply(this).then(res, rej)') || !code.includes('this.delayReconnectAttempt(this.start).catch(')) throw new Error('Slack SDK patch is missing')
      manifest.dependencies = { ...sdk.dependencies, ...manifest.dependencies, undici: '7.30.1' }
      const sdkTarget = path.join(stage, 'node_modules/@slack/socket-mode')
      await fs.mkdir(sdkTarget, { recursive: true })
      for (const file of ['package.json', 'LICENSE', 'dist']) {
        await fs.cp(path.join(sdkSource, file), path.join(sdkTarget, file), { recursive: true })
      }
    }
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2))
    await fs.cp(path.join(source, 'dist'), path.join(stage, 'dist'), { recursive: true })
    await fs.copyFile(path.join(source, 'crabot-module.yaml'), path.join(stage, 'crabot-module.yaml'))
    const sharedTarget = path.join(stage, 'node_modules/crabot-shared')
    await fs.mkdir(sharedTarget, { recursive: true })
    await fs.writeFile(path.join(sharedTarget, 'package.json'), JSON.stringify(shared, null, 2))
    await fs.cp(path.join(sharedSource, 'dist'), path.join(sharedTarget, 'dist'), { recursive: true })
    let npm
    for (const candidate of [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]) {
      try { await fs.access(candidate); npm = candidate; break } catch {}
    }
    if (!npm) throw new Error('Current Node runtime is missing npm')
    const result = await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', path.resolve(destination)], {
      cwd: stage, maxBuffer: 4 * 1024 * 1024,
    })
    const [{ files, ...summary }] = JSON.parse(result.stdout)
    if (files.some(file => /(^|\/)src\//.test(file.path.replace('node_modules/@slack/socket-mode/dist/src/', 'sdk/')) || file.path.includes('.test.') || file.path.includes('.pnpm/'))) throw new Error('Development files leaked into npm artifact')
    return summary
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await pack(process.argv[2], path.resolve(process.argv[3] ?? 'artifacts')), null, 2))
}
