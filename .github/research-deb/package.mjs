// Disposable ordinary electron-builder DEB packages, never a release.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const base = path.resolve('.desktop-build/appimage-research')
const app = path.join(base, 'Crabot.AppDir'), core = path.join(app, 'resources/core')
const require = createRequire(path.join(base, 'tools/package.json'))
const asar = require('@electron/asar'), { build, Platform, Arch } = require('electron-builder')
const project = path.join(base, 'deb-project'), output = path.join(base, 'deb-output')
await fs.mkdir(project, { recursive: true })
const manifest = JSON.parse(await fs.readFile(path.join(core, 'product-runtime.json'), 'utf8'))
const roles = ['crabot-desktop', ...Object.keys(manifest.files)
  .filter(name => /\/browsers\/(?:chromium-[0-9]+\/chrome-linux(?:64)?\/chrome|chromium_headless_shell-[0-9]+\/chrome-headless-shell-linux(?:64)?\/headless_shell)$/.test(name))
  .map(name => 'resources/core/' + name)]
const policy = path.join(project, 'apparmor-profile')
await fs.writeFile(policy, 'abi <abi/4.0>,\n' + roles.map((role, i) => `profile crabot-research-${i} "/opt/CrabotResearch/${role}" flags=(unconfined) { userns, }\n`).join(''))
for (const version of ['0.1.0-desktop.1', '0.1.0-desktop.2']) {
  const gui = path.join(base, 'asar'), pkg = JSON.parse(await fs.readFile(path.join(gui, 'package.json'), 'utf8'))
  pkg.version = version
  await fs.writeFile(path.join(gui, 'package.json'), JSON.stringify(pkg))
  await asar.createPackageWithOptions(gui, path.join(base, 'deb.asar'), { unpack: '**/*.node' })
  await fs.rename(path.join(base, 'deb.asar'), path.join(app, 'resources/app.asar'))
  for (const file of ['package.json', 'product-runtime.json']) {
    const data = JSON.parse(await fs.readFile(path.join(core, file), 'utf8')); data.version = version
    await fs.writeFile(path.join(core, file), JSON.stringify(data) + '\n')
  }
  const release = JSON.parse(await fs.readFile(path.join(core, 'core-release.json'), 'utf8'))
  await fs.unlink(path.join(core, 'core-release.json')); await fs.unlink(path.join(core, 'core-files.json'))
  // Source is unchanged: only candidate version metadata is restamped/resealed.
  const { writeCoreRelease } = await import('../../scripts/lib/core-release.mjs')
  await writeCoreRelease(core, { ...release, version })
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'crabot-research', version,
    productName: 'CrabotResearch', description: 'Isolated Crabot DEB research', author: { name: 'Crabot Research', email: 'research@example.invalid' }, homepage: 'https://github.com/smilefufu/crabot', license: 'MIT' }))
  await build({ projectDir: project, prepackaged: app, publish: 'never', targets: Platform.LINUX.createTarget('deb', Arch.x64), config: {
    appId: 'com.crabot.research', productName: 'CrabotResearch', electronVersion: '44.9.0', npmRebuild: false, publish: null,
    directories: { app: project, output }, linux: { executableName: 'crabot-desktop', icon: path.resolve('crabot-desktop/assets/app.png'), category: 'Utility' },
    deb: { compression: 'zst', packageName: 'crabot-research', appArmorProfile: policy, artifactName: 'crabot-research-' + version + '.deb' },
  } })
}
