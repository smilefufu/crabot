import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { packageWindowsInstaller } from '../../scripts/desktop/package-windows-installer.mjs'

test('Windows packaging contains one final program tree and no Electron installer or duplicate runtime payload', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-single-extraction-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const output = path.join(root, 'output'), source = path.join(root, 'source'), directory = path.join(source, 'offline')
  const coreRoot = path.join(directory, 'core'), guiRoot = path.join(directory, 'gui')
  await fs.mkdir(output); await fs.mkdir(path.join(coreRoot, 'bin'), { recursive: true }); await fs.mkdir(guiRoot, { recursive: true })
  await fs.writeFile(path.join(coreRoot, 'bin/crabot.exe'), 'native CLI bytes')
  await fs.writeFile(path.join(coreRoot, 'runtime.bin'), 'one runtime copy')
  await fs.writeFile(path.join(guiRoot, 'Crabot.exe'), 'actual user GUI bytes')
  const selection = { schema_version: 1, version: '1.2.3', gui_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', core_id: 'b'.repeat(64) }
  const record = { schema_version: 1, platform: 'win32', arch: 'x64', selection, gui: {} }
  await packageWindowsInstaller({ root, output, source, payload: { directory, coreRoot, guiRoot, record }, distribute: false })
  const files = (await fs.readdir(path.join(output, 'programs'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
  assert.equal(files.length, 4)
  assert.equal(await fs.readFile(path.join(output, 'programs/app/releases', selection.gui_id, 'Crabot.exe'), 'utf8'), 'actual user GUI bytes')
  assert.equal(await fs.readFile(path.join(output, 'programs/releases', selection.core_id, 'runtime.bin'), 'utf8'), 'one runtime copy')
  const location = JSON.parse(await fs.readFile(path.join(output, 'installer-location.json'), 'utf8'))
  assert.equal(location.bootstrap, 'windows-first-launch')
  assert.equal(path.resolve(output, location.executable), path.join(output, 'programs/app/releases', selection.gui_id, 'Crabot.exe'))
  for (const absent of ['data', 'desktop-installation.json', 'current-release.json', 'resources/offline', 'CrabotInstaller.exe', 'bin/crabot.exe']) {
    await assert.rejects(fs.lstat(path.join(output, 'programs', absent)), { code: 'ENOENT' })
  }
})

test('Windows install section only decodes to the chosen directory and launches GUI after Finish', async () => {
  const source = await fs.readFile(new URL('../../scripts/desktop/windows-offline-installer.nsi', import.meta.url), 'utf8')
  const section = source.slice(source.indexOf('Section "安装 Crabot"'), source.indexOf('SectionEnd'))
  assert.match(section, /SetOutPath "\$INSTDIR"/)
  assert.doesNotMatch(section, /ExecWait|--install-root|RMDir|StrCpy \$INSTDIR/)
  assert.match(source, /7za\.exe.*-o\$INSTDIR/)
  assert.match(source, /Function OpenCrabot[\s\S]*Exec '/)
  assert.doesNotMatch(source, /Nsis7z::Extract|APP_64_UNPACKED_SIZE\} \* 1024/)
})
