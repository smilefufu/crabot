import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

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
    const root = path.resolve('src')
    for (const file of await sourceFiles(root)) {
      const source = await fs.readFile(file, 'utf8')
      if (!/from ['"](?:node:)?child_process['"]/.test(source)) continue
      expect(source, path.relative(root, file)).toMatch(/buildChildEnv/)
      expect(source, path.relative(root, file)).not.toMatch(/env:\s*process\.env/)
      expect(source, path.relative(root, file)).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/)
      expect(source, path.relative(root, file)).not.toMatch(/const\s+\w*Env\s*=\s*\{\s*\.\.\.process\.env/)
    }
  })
})
