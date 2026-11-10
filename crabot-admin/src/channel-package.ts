import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const CHANNEL_NPM_REGISTRY = 'https://registry.npmmirror.com'
const execute = promisify(execFile)
interface PackageDefinition { name: string; version: string }
interface InstallOptions {
  specification?: string
  registry?: string
  cache?: string
  execute?: typeof execute
}

/** One exact package per directory; installation failure preserves cache and previous versions. */
export class ChannelPackageStore {
  private readonly pending = new Map<string, Promise<string>>()
  constructor(private readonly directory: string) {}

  packagePath(definition: PackageDefinition): string {
    if (definition.name !== 'crabot-channel-feishu' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(definition.version)) {
      throw new Error('Unsupported Channel package')
    }
    return path.resolve(this.directory, definition.name, definition.version, 'node_modules', definition.name)
  }

  async installed(definition: PackageDefinition): Promise<string | undefined> {
    const directory = this.packagePath(definition)
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
      if (manifest.name !== definition.name || manifest.version !== definition.version || manifest.main !== 'dist/main.js') throw new Error('Channel package manifest mismatch')
      await fs.access(path.join(directory, manifest.main))
      await fs.access(path.join(directory, 'crabot-module.yaml'))
      return directory
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }

  ensure(definition: PackageDefinition, options: InstallOptions = {}): Promise<string> {
    definition = { ...definition }
    options = { ...options }
    const destination = path.dirname(path.dirname(this.packagePath(definition)))
    const previous = this.pending.get(destination)
    if (previous) return previous
    const installation = this.install(definition, destination, options)
    this.pending.set(destination, installation)
    void installation.finally(() => this.pending.delete(destination)).catch(() => {})
    return installation
  }

  private async install(definition: PackageDefinition, destination: string, options: InstallOptions): Promise<string> {
    const installed = await this.installed(definition)
    if (installed) return installed
    const registry = options.registry ?? CHANNEL_NPM_REGISTRY
    const origin = new URL(registry).origin
    const cache = options.cache ?? path.join(this.directory, '.npm-cache')
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.mkdir(cache, { recursive: true })
    const stage = await fs.mkdtemp(path.join(path.dirname(destination), '.install-'))
    try {
      await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'crabot-channel-installation', version: '0.0.0', private: true }))
      await fs.writeFile(path.join(stage, 'user.npmrc'), '')
      await fs.writeFile(path.join(stage, 'global.npmrc'), '')
      const env = { ...process.env }
      for (const key of Object.keys(env)) {
        if (!/^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|SHELL|USER|LOGNAME|USERDOMAIN|COMSPEC|PATHEXT|LANG|LC_[A-Z_]+|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)) delete env[key]
      }
      const candidates = [path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
      let npm: string | undefined
      for (const candidate of candidates) { try { await fs.access(candidate); npm = candidate; break } catch {} }
      if (!npm) throw new Error('Current Node runtime is missing npm')
      const args = [npm, 'install', '--prefix', stage, '--registry', registry,
        '--userconfig', path.join(stage, 'user.npmrc'), '--globalconfig', path.join(stage, 'global.npmrc'),
        '--cache', cache, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
        '--fetch-retries=2', '--fetch-timeout=30000', '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=10000',
        '--loglevel=http', 'cordis@4.0.0-rc.12', options.specification ?? `${definition.name}@${definition.version}`]
      console.log(`[ChannelPackageStore] Installing ${definition.name}@${definition.version} from ${origin}`)
      const result = await (options.execute ?? execute)(process.execPath, args, { cwd: stage, env,
        timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
      const lock = JSON.parse(await fs.readFile(path.join(stage, 'package-lock.json'), 'utf8'))
      for (const dependency of Object.values(lock.packages) as { resolved?: string }[]) {
        if (!dependency.resolved || dependency.resolved.startsWith('file:')) continue
        if (new URL(dependency.resolved).origin !== origin) throw new Error('Channel dependency escaped its registry')
      }
      const downloads = new Set<string>()
      for (const match of String(result.stderr).matchAll(/npm http fetch [^\n]*?(https?:\/\/\S+)/g)) {
        const actual = new URL(match[1]).origin
        if (actual !== origin && !(origin === CHANNEL_NPM_REGISTRY && actual === 'https://cdn.npmmirror.com')) throw new Error('Channel download escaped its registry')
        downloads.add(actual)
      }
      const packageDirectory = path.join(stage, 'node_modules', definition.name)
      const manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
      if (manifest.name !== definition.name || manifest.version !== definition.version || manifest.main !== 'dist/main.js') throw new Error('Installed Channel package does not match the catalog')
      await fs.access(path.join(packageDirectory, manifest.main))
      await fs.access(path.join(packageDirectory, 'crabot-module.yaml'))
      await fs.writeFile(path.join(stage, 'installation.json'), JSON.stringify({ ...definition, registry, download_origins: [...downloads] }))
      await fs.rename(stage, destination)
      console.log(`[ChannelPackageStore] Installed ${definition.name}@${definition.version}`)
      return (await this.installed(definition))!
    } catch (cause) {
      throw Object.assign(new Error(`飞书插件安装失败，请检查国内 npm 源及当前网络后重试；下载缓存已保留。`), { cause })
    } finally { await fs.rm(stage, { recursive: true, force: true }) }
  }
}
