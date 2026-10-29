import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Local build receipts only; never read business data, secrets or downloaded resources.
export function developmentBuildState(directory, dependencies = []) {
  const hash = createHash('sha256').update(process.version + process.platform + process.arch)
  function add(file, relative) {
    if (!existsSync(file)) return
    const entries = readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const name = relative + '/' + entry.name, target = join(file, entry.name)
      if (entry.isDirectory()) add(target, name)
      else if (entry.isFile()) hash.update(name).update(readFileSync(target))
    }
  }
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && /^(?:package\.json|pnpm-lock\.yaml|tsconfig.*\.json|vite\.config\..*|build.*\.mjs|.*\.html)$/.test(entry.name)) hash.update(entry.name).update(readFileSync(join(directory, entry.name)))
  }
  for (const name of ['src', 'assets']) add(join(directory, name), name)
  for (const dependency of dependencies) hash.update(dependency)
  const signature = hash.digest('hex'), file = join(directory, 'node_modules/.cache/crabot-dev-build.json')
  let previous
  try { previous = JSON.parse(readFileSync(file, 'utf8')).signature } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  return { signature, ready: previous === signature, commit() {
    mkdirSync(join(directory, 'node_modules/.cache'), { recursive: true })
    writeFileSync(file, JSON.stringify({ signature }) + '\n')
  } }
}
