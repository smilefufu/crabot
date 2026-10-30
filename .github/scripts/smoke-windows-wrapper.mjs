// Execute the installer extraction macro with the actual shipped archive/plugin.
// No installer host, registration, user data, or business MM is started.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
assert.equal(process.platform, 'win32')
const execute = promisify(execFile), repo = process.cwd()
const require = createRequire(path.join(repo, 'crabot-desktop/package.json'))
const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
const builderRoot = path.dirname(builder.resolve('app-builder-lib/package.json'))
const { getMakeNsisPath } = builder(path.join(builderRoot, 'out/toolsets/windows.js'))
const { getPath7za } = builder(path.join(builderRoot, 'out/toolsets/7zip.js'))
const nsis = await getMakeNsisPath(), sevenZip = await getPath7za()
const project = path.resolve(process.argv[2]), distribution = path.join(project, 'distribution')
const installers = (await fs.readdir(distribution)).filter(file => file.endsWith('offline-candidate.exe'))
assert.equal(installers.length, 1)
const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-wrapper-'))
const temporary = path.join(process.env.RUNNER_TEMP || tmpdir(), 'a0000001/b0000002/c0000003/d0000004')
await fs.mkdir(temporary, { recursive: true })
const env = { ...process.env, ...nsis.env, TEMP: temporary, TMP: temporary }
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key]
const run = (file, args, options = {}) => execute(file, args, { env, timeout: 600_000, maxBuffer: 1024 * 1024, ...options })
const quote = value => value.split('$').join('$$').replaceAll('"', '$\\"')
try {
  await run(sevenZip, ['x', path.join(distribution, installers[0]), '-o' + path.join(root, 'wrapper'), '-y'])
  async function find(directory, name) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { const found = await find(file, name); if (found) return found }
      else if (entry.name.toLowerCase() === name.toLowerCase()) return file
    }
  }
  const archive = await find(path.join(root, 'wrapper'), 'app-64.7z')
  const plugin = await find(path.join(root, 'wrapper'), 'nsis7z.dll')
  assert.ok(archive && plugin)
  const original = await fs.readFile(path.join(builderRoot, 'templates/nsis/include/extractAppPackage.nsh'), 'utf8')
  const macro = path.join(root, 'extract.nsh')
  await fs.writeFile(macro, original.replace('    DetailPrint `Can', '    FileWrite $ProbeLog "copy-error$\\r$\\n"\n    DetailPrint `Can'))
  const source = await fs.readFile('scripts/desktop/windows-offline-installer.nsi', 'utf8')
  const leaf = source.match(/StrCpy \$INSTDIR "\$PLUGINSDIR\\([^"\\]+)"/)?.[1]
  assert.ok(leaf && source.includes(`RMDir /r "$PLUGINSDIR\\${leaf}"`))
  const relative = 'resources/offline/core/.scrapling-runtime-desktop-ci-b21869a0a229da99-8413626c/packages/playwright/driver/package/lib/tools/skills/playwright-component-testing/references/gallery-spec.md'
  const fixture = path.join(root, 'fixture'), contents = 'real-package-path-regression'
  await fs.mkdir(path.dirname(path.join(fixture, relative)), { recursive: true })
  await fs.writeFile(path.join(fixture, relative), contents)
  const small = path.join(root, 'fixture.7z')
  await run(sevenZip, ['a', '-t7z', small, '.'], { cwd: fixture })
  const verify = path.join(root, 'verify.mjs'), verified = path.join(root, 'verified.json')
  await fs.writeFile(verify, `import { promises as fs } from 'node:fs'; import path from 'node:path';
import { verifyDesktopPayload } from ${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/lib/desktop-payload.mjs')).href)};
const payload = await verifyDesktopPayload(path.join(process.argv[2], 'resources/offline'));
await fs.writeFile(process.argv[3], JSON.stringify({ complete: true, bytes: String(payload.bytes) }));`)
  async function probe(name, selectedLeaf, input, full) {
    const log = path.join(root, name + '.txt'), script = path.join(root, name + '.nsi'), executable = path.join(root, name + '.exe')
    await fs.writeFile(script, `Unicode true
SilentInstall silent
RequestExecutionLevel user
!include "LogicLib.nsh"
!addplugindir "${quote(path.dirname(plugin))}"
!define PRODUCT_NAME "Crabot Installer"
LangString appCannotBeClosed 1033 "Cannot close installer"
!include "${quote(macro)}"
OutFile "${quote(executable)}"
Var ProbeLog
Section
 InitPluginsDir
 StrCpy $INSTDIR "$PLUGINSDIR\\${selectedLeaf}"
 SetOutPath "$INSTDIR"
 FileOpen $ProbeLog "${quote(log)}" w
 !insertmacro extractUsing7za "${quote(input)}"
 ${full ? `ExecWait '\"$INSTDIR\\resources\\offline\\core\\.product-runtime\\node\\node.exe\" \"${quote(verify)}\" \"$INSTDIR\" \"${quote(verified)}\"' $0\n FileWrite $ProbeLog "verify-exit=$0$\\r$\\n"` : `FileOpen $2 "$INSTDIR\\${relative.replaceAll('/', '\\')}" r\n FileRead $2 $3\n FileClose $2\n FileWrite $ProbeLog "content=$3$\\r$\\n"`}
 FileClose $ProbeLog
SectionEnd
`)
    await run(nsis.path, ['/V2', script])
    await run(executable, [])
    return fs.readFile(log, 'utf8')
  }
  const before = await probe('legacy-path', 'crabot-installer', small, false)
  assert.ok(!before.includes(contents), 'The original long staging path must reproduce the missing file')
  const after = await probe('fixed-path', leaf, small, false)
  assert.ok(after.includes('content=' + contents), 'The shipped private path must retain the long entry')
  assert.ok(!after.includes('copy-error'))
  const complete = await probe('full-package', leaf, archive, true)
  assert.ok(!complete.includes('copy-error'), 'The full package must not enter the Retry branch')
  assert.ok(complete.includes('verify-exit=0'))
  assert.equal(JSON.parse(await fs.readFile(verified, 'utf8')).complete, true)
  console.log('CRABOT_WINDOWS_WRAPPER ' + JSON.stringify({ old_path_reproduced: true, fixed_long_path: true, full_payload_inventory: true, retry_branch: false, business_mm_started: false }))
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
