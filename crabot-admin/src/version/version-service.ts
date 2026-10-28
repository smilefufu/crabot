import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpgradeCapability, VersionState, DeployMode, InstallKind } from './types.js'
import { defaultGitRunner } from './git.js'
import { readUpgradeStatus } from './upgrade-runner.js'

const { readCoreVersion } = require('../../../scripts/lib/cli-location.cjs') as { readCoreVersion: (root: string) => string | null }

const SIX_HOURS = 6 * 60 * 60 * 1000

export interface VersionServiceDeps {
  crabotHome: string
  dataDir: string
  etcDir?: string
  proxyUrlProvider?: () => string | null
  gitRunner?: (args: string[], opts?: { cwd?: string; proxyUrl?: string | null }) => string
  fetchLatestTag?: () => Promise<string>
  now?: () => number
  ttlMs?: number
}

/** 复制 upgrade-lib/release.mjs 的 302 逻辑：admin 内全局 fetch 已走代理 */
async function fetchLatestTagDefault(): Promise<string> {
  const res = await fetch('https://github.com/smilefufu/crabot/releases/latest', {
    redirect: 'manual',
    headers: { 'User-Agent': 'crabot-upgrade' },
  })
  const location = res.headers.get('location')
  if (!location) throw new Error(`failed to fetch latest release: status=${res.status}`)
  const m = location.match(/\/releases\/tag\/([^/?#]+)/)
  if (!m) throw new Error(`failed to parse tag from redirect: ${location}`)
  return decodeURIComponent(m[1])
}

export class VersionService {
  private deps: Required<Pick<VersionServiceDeps, 'crabotHome' | 'dataDir' | 'etcDir' | 'now' | 'ttlMs'>> & VersionServiceDeps
  private cache: VersionState | null = null
  private lastCheckedMs = 0
  private checking = false

  constructor(deps: VersionServiceDeps) {
    this.deps = {
      etcDir: '/etc/crabot',
      now: () => Date.now(),
      ttlMs: SIX_HOURS,
      ...deps,
    }
  }

  private resolveDeployMode(): DeployMode {
    return existsSync(join(this.deps.etcDir, 'cluster.version')) ? 'system' : 'user'
  }

  private resolveInstallKind(): InstallKind {
    return existsSync(join(this.deps.crabotHome, '.git')) ? 'source' : 'release'
  }

  private resolveCapability(): UpgradeCapability {
    return this.resolveDeployMode() === 'system' ? 'system' : this.resolveInstallKind()
  }

  private readVersionFile(): string | null {
    const sealed = readCoreVersion(this.deps.crabotHome)
    if (sealed !== null) return sealed
    const p = join(this.deps.crabotHome, 'VERSION')
    if (!existsSync(p)) return null
    const v = readFileSync(p, 'utf-8').trim()
    return v || null
  }

  /** 同步读缓存；TTL 过期且非进行中时触发后台刷新 */
  getState(): VersionState {
    if (!this.cache) {
      return {
        current_version: null, latest_version: null, upgrade_available: false,
        upgrade_capability: this.resolveCapability(),
        deploy_mode: this.resolveDeployMode(),
        install_kind: this.resolveInstallKind(),
        last_checked: null, checking: this.checking,
        last_upgrade: readUpgradeStatus(this.deps.dataDir),
      }
    }
    if (this.deps.now() - this.lastCheckedMs > this.deps.ttlMs && !this.checking) {
      void this.check()
    }
    return { ...this.cache, checking: this.checking, last_upgrade: readUpgradeStatus(this.deps.dataDir) }
  }

  /** 强制同步重查并刷新缓存 */
  async check(): Promise<VersionState> {
    if (this.checking) return this.getState()
    this.checking = true
    const deployMode = this.resolveDeployMode()
    const installKind = this.resolveInstallKind()
    const capability: UpgradeCapability = deployMode === 'system' ? 'system' : installKind
    const base: VersionState = {
      current_version: null, latest_version: null, upgrade_available: false,
      upgrade_capability: capability, deploy_mode: deployMode, install_kind: installKind,
      last_checked: null, checking: true, error: null,
      last_upgrade: readUpgradeStatus(this.deps.dataDir),
    }
    try {
      // 不论 user/system 都按安装方式查版本（system mode 卡片只读展示，升级按钮在前端禁掉）
      this.cache = installKind === 'release'
        ? await this.checkRelease(base)
        : this.checkSource(base)
      this.lastCheckedMs = this.deps.now()
      return this.cache
    } catch (err) {
      this.cache = { ...base, checking: false, error: err instanceof Error ? err.message : String(err),
        last_checked: new Date(this.deps.now()).toISOString() }
      this.lastCheckedMs = this.deps.now()
      return this.cache
    } finally {
      this.checking = false
    }
  }

  private async checkRelease(base: VersionState): Promise<VersionState> {
    const current = this.readVersionFile()
    const latest = await (this.deps.fetchLatestTag ?? fetchLatestTagDefault)()
    return {
      ...base, checking: false, current_version: current, latest_version: latest,
      upgrade_available: latest.replace(/^v/, '') !== current?.replace(/^v/, ''),
      last_checked: new Date(this.deps.now()).toISOString(),
    }
  }

  private checkSource(base: VersionState): VersionState {
    const home = this.deps.crabotHome
    const git = this.deps.gitRunner ?? defaultGitRunner
    const proxyUrl = this.deps.proxyUrlProvider?.() ?? null

    const remoteLine = git(['ls-remote', 'origin', 'main'], { cwd: home, proxyUrl })
    const remoteSha = remoteLine.split(/\s+/)[0] ?? ''
    if (!remoteSha) throw new Error('ls-remote: origin 上找不到 main 分支')

    // 本地是否已包含远端 main 这个 commit。用 merge-base --is-ancestor 判断「remoteSha 是否是
    // HEAD 的祖先」（真正的『已合并』语义），而非 cat-file -e——后者只看对象是否存在于本地库，
    // 一旦 fetch 过远端对象（手动 / IDE / 其他工具）就会误判已含，导致明明落后却显示『已是最新』。
    // merge-base 在本地缺该对象时也会非零退出 → 落到 catch → 判定未含，行为正确。
    let localHasCommit = true
    try {
      git(['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { cwd: home })
    } catch {
      localHasCommit = false
    }

    const dirty = git(['status', '--porcelain'], { cwd: home }).length > 0
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: home })
    const head = git(['rev-parse', '--short', 'HEAD'], { cwd: home })

    const blockers: string[] = []
    if (dirty) blockers.push('工作区有未提交改动')
    if (branch !== 'main') blockers.push('当前不在 main 分支')

    return {
      ...base,
      checking: false,
      current_version: head,
      latest_version: remoteSha.slice(0, 7),
      upgrade_available: !localHasCommit,
      source_blockers: blockers,
      last_checked: new Date(this.deps.now()).toISOString(),
    }
  }
}
