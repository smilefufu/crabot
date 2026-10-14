import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runBounded } from './scrapling-prepare.mjs'

const legacy = { 'v2026.9.23': [], 'v2026.10.12.4': ['scrapling'] }
const components = {
  scrapling: ['scripts/prepare-scrapling.mjs', 'scripts/lib/scrapling-runtime.cjs', 'scripts/scrapling/runtime.json', 'scrapling-runtime.json'],
  'computer-use': ['scripts/prepare-computer-use.mjs', 'scripts/lib/computer-use-runtime.cjs', 'scripts/computer-use/runtime.json', 'crabot-mcp-tools/dist/computer-use/service.js'],
}
export async function verifyReleasePackage(root, version, { run = runBounded } = {}) {
  const required = ['cli.mjs', 'package.json', 'dist/cli/main.js', 'scripts/start.mjs', 'crabot-memory/pyproject.toml', 'crabot-memory/uv.lock']
  if (!Object.hasOwn(legacy, version)) required.push('scripts/check-release.mjs')
  for (const file of required) if (!existsSync(join(root, file))) throw new Error(`Release package missing ${file}`)
  for (const [name, files] of Object.entries(components)) {
    if (Object.hasOwn(legacy, version) && !legacy[version].includes(name)) {
      if (files.some(file => existsSync(join(root, file)))) throw new Error(`Release package has mixed ${name} generation: ${version}`)
      continue
    }
    for (const file of files) if (!existsSync(join(root, file))) throw new Error(`Release package incomplete: missing ${file}`)
    await run(process.execPath, [join(root, files[0]), '--check'], { cwd: root, timeout: 120_000 })
  }
}
