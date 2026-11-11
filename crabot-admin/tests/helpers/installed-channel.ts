import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { CHANNEL_CATALOG } from '../../src/channel-catalog.js'

/** Synthetic installed package for manager tests; no platform code or accounts are started. */
export async function installTestChannel(data: string, platform: string) {
  const name = `crabot-channel-${platform}`
  const version = CHANNEL_CATALOG.find(item => item.platform === platform)!.version
  const root = path.join(data, 'channel-packages', name, version, 'node_modules', name)
  await fs.mkdir(path.join(root, 'dist'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version, main: 'dist/main.js' }))
  await fs.writeFile(path.join(root, 'dist/main.js'), 'exports.apply=()=>{};exports.createConfig=()=>({})')
  const metadata = await fs.readFile(path.resolve(__dirname, `../../../${name}/crabot-module.yaml`), 'utf8')
  await fs.writeFile(path.join(root, 'crabot-module.yaml'), metadata)
  for (const method of (yaml.load(metadata) as { onboarding_methods?: { handler: string }[] }).onboarding_methods ?? []) {
    const target = path.join(root, method.handler)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'exports.createOnboarder=()=>({})')
  }
  await fs.writeFile(path.join(root, '../../installation.json'), JSON.stringify({ name, version }))
  return root
}
