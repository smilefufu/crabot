// CI-only read-only failure evidence. No unmount, process signal or system setting changes.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'darwin') throw new Error('Expected isolated macOS CI')
const root = path.resolve('.desktop-build'), report = { volumes: [] }
const run = (file, args, input) => execFileSync(file, args, { input, encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
try {
  const pkg = JSON.parse(await fs.readFile(path.join(root, '安装 候选/installer/app/package.json'), 'utf8'))
  const title = 'Crabot Installer ' + pkg.version
  const titles = [title, title + '-arm64', title + '-x64']
  const plist = run('/usr/bin/hdiutil', ['info', '-plist'])
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], plist))
  for (const image of info.images ?? []) {
    for (const entity of image['system-entities'] ?? []) {
      const mount = entity['mount-point'], name = typeof mount === 'string' ? path.basename(mount) : ''
      if (path.dirname(mount ?? '') !== '/Volumes' || !titles.some(value => name === value || name.startsWith(value + ' ') && /^\d+$/.test(name.slice(value.length + 1)))) continue
      if (report.volumes.length >= 3) break
      const row = { image: path.basename(image['image-path'] ?? ''), volume: name, processes: [] }
      try {
        const output = run('/usr/sbin/lsof', ['-nP', '-Fpc', '+f', '--', mount])
        const counts = new Map()
        for (const line of output.split('\n')) if (line.startsWith('c')) counts.set(line.slice(1), (counts.get(line.slice(1)) ?? 0) + 1)
        row.processes = [...counts].map(([command, count]) => ({ command, count }))
      } catch (error) {
        row.observation = error.status === 1 && !error.stdout?.length ? 'no-open-files' : 'unavailable'
      }
      report.volumes.push(row)
    }
  }
} catch { report.observation = 'unavailable' }
await fs.mkdir(root, { recursive: true })
await fs.writeFile(path.join(root, 'dmg-failure.json'), JSON.stringify(report, null, 2) + '\n')
console.log('Saved bounded installer-volume occupancy metadata; original build result is unchanged.')
