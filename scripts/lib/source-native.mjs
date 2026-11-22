import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runBounded } from './run-bounded.mjs'
import { detectMode } from './mode.mjs'
import build from './native-build.cjs'

export async function verifySourceNative(root, directory = build.standardDirectory(root)) {
  if (!build.nativeReady(root, directory)) throw build.failure('原生产物缺失、损坏或构建凭据已过期')
  await runBounded(process.execPath, [path.join(root, 'scripts/lib/native-probe.cjs'), directory], { cwd: root, timeout: 30000 })
}

// Explicit upgrade preparation only; never called by the read-only addon loader.
export async function prepareSourceNative(root) {
  if (!build.isSourceTree(root)) return
  if (detectMode() === 'system' && process.getuid?.() !== 0) throw build.failure('共享源码升级需要管理员执行')
  root = await fs.realpath(root)
  await fs.access(root, constants.W_OK)
  const { stdout } = await promisify(execFile)('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, timeout: 30000 })
  if (stdout.trim()) throw build.failure('Source checkout has uncommitted changes')
  const signature = build.nativeSignature(root), destination = build.bootstrapDirectory(root, signature)
  if (build.nativeReady(root, destination, signature)) { await verifySourceNative(root, destination); return }
  const parent = path.dirname(destination)
  // Validate each newly created component; do not follow an existing cache symlink.
  for (const directory of [path.dirname(parent), parent]) {
    try { await fs.mkdir(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    build.trustedPaths(root, [directory])
  }
  const temporary = await fs.mkdtemp(path.join(parent, '.preparing-'))
  try {
    console.log('[upgrade] preparing isolated native helper')
    await runBounded(process.execPath, [path.join(root, 'scripts/build-native.mjs'), '--output', temporary], { cwd: root })
    await verifySourceNative(root, temporary)
    try { await fs.rename(temporary, destination) }
    catch (error) {
      // A concurrent complete build may have won. Never replace its loaded files.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error
      await verifySourceNative(root, destination)
    }
    if (build.nativeSignature(root) !== signature) throw build.failure('引导期间输入发生变化')
    await verifySourceNative(root, destination)
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
}
