import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ts from 'typescript'

// A Windows DLL loaded by the staging parent cannot be overwritten by its
// compiler child. Exercise the actual transitive imports, not their spelling.
test('Core staging bootstrap does not load the native binary it still needs to build', async () => {
  const entry = new URL('../../desktop/stage-core.mjs', import.meta.url)
  const source = ts.createSourceFile(entry.pathname, await fs.readFile(entry, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const imports = source.statements.filter(ts.isImportDeclaration).map(statement => {
    const specifier = statement.moduleSpecifier.text
    const resolved = specifier.startsWith('.') ? new URL(specifier, entry).href : specifier
    return statement.getText(source).replace(statement.moduleSpecifier.getText(source), JSON.stringify(resolved))
  }).join('\n')
  const code = imports + `\nimport { createRequire } from 'node:module';
    const local = createRequire(${JSON.stringify(entry.href)});
    console.log(JSON.stringify({ native_loaded: Object.keys(local.cache).some(file => /crabot-native[.]node$/.test(file)) }));`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 10_000 })
  assert.deepEqual(JSON.parse(stdout), { native_loaded: false })
})
