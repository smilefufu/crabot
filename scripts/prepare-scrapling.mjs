#!/usr/bin/env node
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareRuntime, runBounded } from './lib/scrapling-prepare.mjs'
import runtime from './lib/scrapling-runtime.cjs'
import { detectMode } from './lib/mode.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const abort = new AbortController()
process.once('SIGINT', () => abort.abort())
process.once('SIGTERM', () => abort.abort())
try {
  let ready
  if (args.includes('--check') || (detectMode() === 'system' && process.getuid?.() !== 0)) {
    ready = runtime.loadRuntime(root, { full: true })
  } else {
    const release = args.find(arg => arg.startsWith('--release='))?.slice('--release='.length) ?? 'source'
    ready = await prepareRuntime(root, { release, signal: abort.signal })
    console.log(`[crabot] Scrapling ready: ${ready.directory}`)
  }
  if (process.platform === 'linux') {
    // 除完整性外实际加载 ELF/锁定 Python 包，兼容性失败不能写成已就绪。
    await runBounded(join(ready.directory, ready.manifest.command), ['-I', '-B', '-c',
      'import sys; sys.path.insert(0, sys.argv[1]); from scrapling.core.ai import ScraplingMCPServer',
      join(ready.directory, 'packages')], { timeout: 30_000, signal: abort.signal })
    await runBounded(join(ready.directory, ready.manifest.browser), ['--version'], { timeout: 30_000, signal: abort.signal })
  }
} catch (err) {
  console.error(`[crabot] Scrapling preparation failed: ${err.message}`)
  process.exitCode = 1
}
