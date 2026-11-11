import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function retentionLocation(file: string): Promise<string> {
  try { return await fs.realpath(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(path.resolve(file))
    if (parent === file) throw error
    return path.join(await retentionLocation(parent), path.basename(file))
  }
}

/** Missing is harmless; redirected or non-directory ancestors are never deletion authority. */
export async function retentionPath(root: string, segments: string[]): Promise<string | undefined> {
  try {
    let current = await fs.realpath(root)
    for (const [index, segment] of segments.entries()) {
      if (!segment || segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) throw new Error('Invalid retention path')
      current = path.join(current, segment)
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink() || index < segments.length - 1 && !stat.isDirectory()) throw new Error('Redirected retention path')
    }
    return current
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function pathsOverlap(left: string, right: string): boolean {
  const inside = (parent: string, child: string) => {
    const relative = path.relative(path.resolve(parent), path.resolve(child))
    return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }
  return inside(left, right) || inside(right, left)
}
