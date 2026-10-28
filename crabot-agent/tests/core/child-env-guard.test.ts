import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(target))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(target)
  }
  return files
}

describe('Agent child environment guard', () => {
  it('requires every child_process owner to import the scrubbed environment helper', async () => {
    const root = fileURLToPath(new URL('../../src/', import.meta.url))
    for (const file of await sourceFiles(root)) {
      const source = await fs.readFile(file, 'utf8')
      if (!/from ['"](?:node:)?child_process['"]/.test(source)) continue
      if (path.relative(root, file).split(path.sep).join('/') === 'workers/headless-native-processes.ts') {
        // This observer uses instanceof only; adding a launcher must restore the normal env guard.
        expect(source).toMatch(/import \{ ChildProcess \} from ['"]node:child_process['"]/)
        expect(source).not.toMatch(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\b|new\s+ChildProcess\b/)
        continue
      }
      // P6-B：buildScrubbedChildEnv（worker/installer/setup 的强 allowlist 版）与
      // buildChildEnv（Slice 0 bearer-scrub 基线）都是受认可的 env helper。
      expect(source, path.relative(root, file)).toMatch(/buildChildEnv|buildMcpChildEnv|buildScrubbedChildEnv/)
      expect(source, path.relative(root, file)).not.toMatch(/env:\s*process\.env/)
      expect(source, path.relative(root, file)).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/)
      expect(source, path.relative(root, file)).not.toMatch(/const\s+\w*Env\s*=\s*\{\s*\.\.\.process\.env/)
    }
  })
})
