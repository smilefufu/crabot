import { existsSync, readFileSync, mkdirSync, renameSync, rmSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform, arch } from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

export function getCurrentVersion(crabotHome) {
  const p = join(crabotHome, 'VERSION')
  if (!existsSync(p)) return null
  const v = readFileSync(p, 'utf-8').trim()
  return v || null
}

export function detectPlatform() {
  const osMap = { darwin: 'darwin', linux: 'linux' }
  const archMap = { arm64: 'arm64', x64: 'x64' }
  const o = osMap[platform()]
  const a = archMap[arch()]
  if (!o || !a) throw new Error(`unsupported platform: ${platform()}-${arch()}`)
  return `${o}-${a}`
}

export async function getLatestVersion() {
  // 走 /releases/latest 的 302 重定向拿 tag，避开 api.github.com 的 60 次/小时未认证限制
  // 与 install.sh 保持一致
  const res = await fetch('https://github.com/smilefufu/crabot/releases/latest', {
    redirect: 'manual',
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
  const res = await fetch(url, { headers: { 'User-Agent': 'crabot-upgrade' } })
  if (!res.ok) throw new Error(`download failed: ${url} → ${res.status}`)
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(destPath)
    Readable.fromWeb(res.body).pipe(ws)
    ws.on('finish', resolve)
    ws.on('error', reject)
  })
}

async function sha256OfFile(path) {
  const hash = createHash('sha256')
  const fs = await import('node:fs')
  const stream = fs.createReadStream(path)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

function extractTarGz(tarPath, destDir) {
  return new Promise((resolve, reject) => {
    mkdirSync(destDir, { recursive: true })
    const proc = spawn('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1'])
    proc.on('error', reject)
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
  })
}

export async function downloadAndExtract({ url, sha256Url, crabotHome, logger }) {
  const tmp = join(tmpdir(), `crabot-upgrade-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const tarPath = join(tmp, 'release.tar.gz')

  logger.info(`Downloading ${url}`)
  await downloadFile(url, tarPath)

  if (sha256Url) {
    logger.info('Verifying checksum')
    const expectedRes = await fetch(sha256Url, { headers: { 'User-Agent': 'crabot-upgrade' } })
    if (!expectedRes.ok) throw new Error(`sha256 fetch failed: ${expectedRes.status}`)
    const expectedLine = (await expectedRes.text()).trim().split(/\s+/)[0]
    const actual = await sha256OfFile(tarPath)
    if (actual !== expectedLine) {
      throw new Error(`checksum mismatch: expected ${expectedLine}, got ${actual}`)
    }
  }

  const stage = join(tmp, 'stage')
  await extractTarGz(tarPath, stage)

  const fs = await import('node:fs')
  if (fs.existsSync(join(stage, 'data'))) {
    rmSync(join(stage, 'data'), { recursive: true, force: true })
  }
  for (const name of fs.readdirSync(stage)) {
    if (name === 'data') continue
    const target = join(crabotHome, name)
    if (fs.existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(join(stage, name), target)
  }

  rmSync(tmp, { recursive: true, force: true })
}

export async function writeVersionFile(crabotHome, version) {
  const fs = await import('node:fs/promises')
  await fs.writeFile(join(crabotHome, 'VERSION'), `${version}\n`, 'utf-8')
}
