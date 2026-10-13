import { existsSync, readFileSync, mkdirSync, rmSync, createWriteStream, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform, arch } from 'node:os'
import { runBounded } from '../lib/scrapling-prepare.mjs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { verifyReleasePackage } from '../lib/release-package.mjs'

export function getCurrentVersion(crabotHome) {
  const p = join(crabotHome, 'VERSION')
  if (!existsSync(p)) return null
  const v = readFileSync(p, 'utf-8').trim()
  return v || null
}

export function detectPlatform(os = platform(), cpu = arch()) {
  const osMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
  const value = `${osMap[os]}-${cpu}`
  if (!['darwin-x64', 'darwin-arm64', 'linux-x64', 'windows-x64'].includes(value)) {
    throw new Error(`unsupported platform: ${os}-${cpu}; no native release is published`)
  }
  return value
}

export function getReleaseUrls(version, target = detectPlatform()) {
  if (!['darwin-x64', 'darwin-arm64', 'linux-x64', 'windows-x64'].includes(target)) throw new Error(`unsupported platform: ${target}`)
  const extension = target === 'windows-x64' ? 'zip' : 'tar.gz'
  const url = `https://github.com/smilefufu/crabot/releases/download/${encodeURIComponent(version)}/crabot-${encodeURIComponent(version)}-${target}.${extension}`
  return { url, sha256Url: `${url}.sha256`, version }
}

export async function getLatestVersion() {
  // 走 /releases/latest 的 302 重定向拿 tag，避开 api.github.com 的 60 次/小时未认证限制
  // 与 install.sh 保持一致
  const res = await fetch('https://github.com/smilefufu/crabot/releases/latest', {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'crabot-upgrade' },
  })
  const location = res.headers.get('location')
  if (!location) {
    throw new Error(`failed to fetch latest release: status=${res.status}, no Location header`)
  }
  const m = location.match(/\/releases\/tag\/([^/?#]+)/)
  if (!m) {
    throw new Error(`failed to parse tag from redirect: ${location}`)
  }
  return { tag: decodeURIComponent(m[1]), publishedAt: null }
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, { headers: { 'User-Agent': 'crabot-upgrade' }, signal: AbortSignal.timeout(900_000) })
  if (!res.ok) throw new Error(`download failed: ${url} → ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath))
}

async function sha256OfFile(path) {
  const hash = createHash('sha256')
  const fs = await import('node:fs')
  const stream = fs.createReadStream(path)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function extractArchive(archive, directory) {
  mkdirSync(directory, { recursive: true })
  if (archive.endsWith('.zip')) {
    await runBounded('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:CRABOT_UPGRADE_ARCHIVE -DestinationPath $env:CRABOT_UPGRADE_STAGE -Force'], {
      env: { ...process.env, CRABOT_UPGRADE_ARCHIVE: archive, CRABOT_UPGRADE_STAGE: directory }, timeout: 120_000,
    })
  } else await runBounded('tar', ['-xzf', archive, '-C', directory, '--strip-components=1'], { timeout: 120_000 })
}

function moveEntry(fs, source, target) {
  try { fs.renameSync(source, target) } catch (error) {
    if (error.code !== 'EXDEV') throw error
    fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    fs.rmSync(source, { recursive: true, force: true })
  }
}

// 下载 + 校验（可在实例运行期做，失败不影响服务）。返回临时目录与 tar 路径，留给 extractRelease。
export async function downloadRelease({ url, sha256Url, version, logger }) {
  const tmp = mkdtempSync(join(tmpdir(), 'crabot-upgrade-'))
  const tarPath = join(tmp, url.endsWith('.zip') ? 'release.zip' : 'release.tar.gz')
  try {
    logger.info(`Downloading ${url}`)
    await downloadFile(url, tarPath)
    if (!sha256Url) throw new Error('release checksum URL is required')
    logger.info('Verifying checksum')
    const expectedRes = await fetch(sha256Url, { headers: { 'User-Agent': 'crabot-upgrade' }, signal: AbortSignal.timeout(60_000) })
    if (!expectedRes.ok) throw new Error(`sha256 fetch failed: ${expectedRes.status}`)
    const expected = (await expectedRes.text()).trim().split(/\s+/)[0]
    if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('invalid release SHA-256 manifest')
    const actual = await sha256OfFile(tarPath)
    if (actual !== expected.toLowerCase()) throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`)
    return { tmp, tarPath, version }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw error
  }
}

// 解压 + 覆盖安装目录（必须在 stop 之后做：覆盖的是运行代码文件）。
export async function extractRelease({ tmp, tarPath, version, crabotHome, logger }) {
  let stage = join(tmp, 'stage')
  try {
    await extractArchive(tarPath, stage)
    const fs = await import('node:fs')
    if (tarPath.endsWith('.zip')) {
      const entries = fs.readdirSync(stage)
      if (entries.length !== 1 || !fs.statSync(join(stage, entries[0])).isDirectory()) throw new Error('invalid release ZIP root')
      stage = join(stage, entries[0])
    }
    await verifyReleasePackage(stage, version)
    const retained = new Set(['data', 'instance.json', 'agent-venv', 'VERSION'])
    for (const name of fs.readdirSync(stage)) {
      if (retained.has(name) || (name === 'crabot.cmd' && existsSync(join(crabotHome, name)))) continue
      const target = join(crabotHome, name)
      if (name === '.computer-use-runtime' && existsSync(target)) {
        for (const child of fs.readdirSync(join(stage, name))) {
          rmSync(join(target, child), { recursive: true, force: true })
          moveEntry(fs, join(stage, name, child), join(target, child))
        }
      } else {
        rmSync(target, { recursive: true, force: true })
        moveEntry(fs, join(stage, name), target)
      }
    }
    logger?.info?.('Extracted verified release')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 一体版：下载、完整校验后再替换产品文件。
export async function downloadAndExtract({ url, sha256Url, version, crabotHome, logger }) {
  const artifact = await downloadRelease({ url, sha256Url, version, logger })
  await extractRelease({ ...artifact, crabotHome, logger })
}

export async function writeVersionFile(crabotHome, version) {
  const fs = await import('node:fs/promises')
  await fs.writeFile(join(crabotHome, 'VERSION'), `${version}\n`, 'utf-8')
}
