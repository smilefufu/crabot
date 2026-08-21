import { watch as fsWatch, type FSWatcher } from 'fs'
import { basename, dirname, relative, sep } from 'path'

/**
 * Watches a native session file as an append signal. The callback carries no session content;
 * callers must still use their durable cursor and ignore an incomplete final JSONL line.
 */
export function watchNativeSessionFile(
  path: () => string | undefined,
  onAppend: () => void,
): () => void {
  let watcher: FSWatcher | undefined
  let stopped = false

  const install = () => {
    watcher?.close()
    watcher = undefined
    if (stopped) return
    const target = path()
    if (!target) return

    let candidate = dirname(target)
    while (true) {
      try {
        const next = fsWatch(candidate, (_eventType, filename) => {
          if (stopped || !affectsTarget(candidate, path(), filename)) return
          onAppend()
          if (candidate !== dirname(path() ?? '')) install()
        })
        next.on('error', () => {
          if (watcher === next) install()
        })
        watcher = next
        return
      } catch {
        const parent = dirname(candidate)
        if (parent === candidate) return
        candidate = parent
      }
    }
  }

  install()
  return () => {
    stopped = true
    watcher?.close()
    watcher = undefined
  }
}

function affectsTarget(watchedDir: string, target: string | undefined, filename: string | Buffer | null): boolean {
  if (!target || !filename) return true
  const relativeTarget = relative(watchedDir, target)
  if (!relativeTarget || relativeTarget.startsWith(`..${sep}`) || relativeTarget === '..') return false
  const topLevel = relativeTarget.split(sep, 1)[0]
  return String(filename) === (topLevel || basename(target))
}
