import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(target))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(target)
  }
  return files
}

function importsChildLauncher(source: string): boolean {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest)
  return file.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !['child_process', 'node:child_process'].includes(statement.moduleSpecifier.text)) return false
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly) return false
    if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return true
    return clause.namedBindings.elements.some(binding => !binding.isTypeOnly && (binding.propertyName ?? binding.name).text !== 'ChildProcess')
  })
}

describe('Agent child environment guard', () => {
  it('distinguishes process observation from imports that can launch children', () => {
    expect(importsChildLauncher("import { ChildProcess } from 'node:child_process'")).toBe(false)
    expect(importsChildLauncher("import type { SpawnOptions } from 'node:child_process'")).toBe(false)
    for (const bindings of ['{ spawn }', '{ ChildProcess, execFile as run }', '* as childProcess', 'childProcess']) {
      expect(importsChildLauncher(`import ${bindings} from 'node:child_process'`)).toBe(true)
    }
  })
  it('requires every child process launcher to import the scrubbed environment helper', async () => {
    const root = path.resolve('src')
    for (const file of await sourceFiles(root)) {
      const source = await fs.readFile(file, 'utf8')
      if (!importsChildLauncher(source)) continue
      // P6-B：buildScrubbedChildEnv（worker/installer/setup 的强 allowlist 版）与
      // buildChildEnv（Slice 0 bearer-scrub 基线）都是受认可的 env helper。
      expect(source, path.relative(root, file)).toMatch(/buildChildEnv|buildMcpChildEnv|buildScrubbedChildEnv/)
      expect(source, path.relative(root, file)).not.toMatch(/env:\s*process\.env/)
      expect(source, path.relative(root, file)).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/)
      expect(source, path.relative(root, file)).not.toMatch(/const\s+\w*Env\s*=\s*\{\s*\.\.\.process\.env/)
    }
  })
})
