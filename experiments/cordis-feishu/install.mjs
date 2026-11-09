import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

export const DOMESTIC_REGISTRY = 'https://registry.npmmirror.com'
const run = promisify(execFile)

/** Install into a NEW directory. A failed attempt never replaces an existing installation. */
export async function install(installDir, pluginSpec, registry = DOMESTIC_REGISTRY) {
  const registryUrl = new URL(registry)
  const origin = registryUrl.origin
  if (!['https:', 'http:'].includes(registryUrl.protocol)) throw new Error('Invalid npm registry')
  await fs.mkdir(installDir)
  try {
    await fs.writeFile(path.join(installDir, 'package.json'), JSON.stringify({ name: 'cordis-feishu-validation-host', version: '0.0.0', private: true }))
    await fs.writeFile(path.join(installDir, '.npmrc'), '')
    await fs.writeFile(path.join(installDir, 'global.npmrc'), '')
    const args = ['install', '--prefix', installDir, '--registry', registry,
      '--userconfig', path.join(installDir, '.npmrc'), '--globalconfig', path.join(installDir, 'global.npmrc'),
      '--cache', path.join(installDir, '.npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund',
      '--fetch-retries=0', '--fetch-timeout=30000', '--loglevel=http', '--save-exact',
      'cordis@4.0.0-rc.12', pluginSpec]
    const result = await run('npm', args, {
      cwd: installDir,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
      maxBuffer: 4 * 1024 * 1024,
    })
    const lock = JSON.parse(await fs.readFile(path.join(installDir, 'package-lock.json'), 'utf8'))
    const sources = new Set()
    for (const pkg of Object.values(lock.packages)) {
      if (!pkg.resolved || pkg.resolved.startsWith('file:')) continue
      if (new URL(pkg.resolved).origin !== origin) throw new Error(`Dependency escaped selected registry: ${pkg.resolved}`)
      sources.add(pkg.resolved)
    }
    const downloadOrigins = new Set()
    const allowedOrigins = new Set([origin])
    if (origin === DOMESTIC_REGISTRY) allowedOrigins.add('https://cdn.npmmirror.com')
    for (const match of result.stderr.matchAll(/npm http fetch [^\n]*?(https?:\/\/\S+)/g)) {
      const actual = new URL(match[1]).origin
      if (!allowedOrigins.has(actual)) throw new Error(`Download escaped selected registry: ${actual}`)
      downloadOrigins.add(actual)
    }
    createRequire(path.join(installDir, 'package.json'))('crabot-channel-feishu')
    await fs.writeFile(path.join(installDir, 'installation-evidence.json'), JSON.stringify({ registry, sources: [...sources], downloadOrigins: [...downloadOrigins], npmOutput: result.stdout + result.stderr }, null, 2))
    return { registry, packages: sources.size }
  } catch (error) {
    await fs.rm(installDir, { recursive: true, force: true })
    throw error
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [installDir, pluginSpec, registry] = process.argv.slice(2)
  if (!installDir || !pluginSpec) throw new Error('Usage: node install.mjs NEW_INSTALL_DIR EXACT_PACKAGE_OR_TARBALL [REGISTRY]')
  console.log(await install(path.resolve(installDir), pluginSpec, registry))
}
