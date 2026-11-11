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


test('sealed Core provides the managed host while advertised Channels remain npm-only', async () => {
  const strings = async (file, name) => {
    const source = ts.createSourceFile(file.pathname, await fs.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(source) === name && ts.isArrayLiteralExpression(declaration.initializer))
          return declaration.initializer.elements.map(value => value.text)
      }
    }
    assert.fail('Missing module inventory: ' + name)
  }
  const catalog = await fs.readFile(new URL('../../../crabot-admin/src/channel-catalog.ts', import.meta.url), 'utf8')
  const javascript = ts.transpileModule(catalog, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText
  const { CHANNEL_CATALOG } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'))
  assert.equal(CHANNEL_CATALOG.length, 6)
  const packaged = await strings(new URL('../../desktop/stage-core.mjs', import.meta.url), 'modules')
  assert.ok(packaged.includes('crabot-core'), 'The managed Channel host must ship with Core')
  for (const item of CHANNEL_CATALOG) assert.equal(packaged.includes(item.package_name), false, 'Channel must be installed from npm: ' + item.package_name)
})
