// Windows installs the final program tree once. Data admission belongs to GUI
// first use, so no second Electron installer is built or run from TEMP.
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
export async function packageWindowsInstaller({ root, output, source, payload, distribute }) {
  const selected = payload.record.selection, programs = path.join(output, 'programs')
  const gui = path.join(programs, 'app/releases', selected.gui_id), core = path.join(programs, 'releases', selected.core_id)
  await fs.mkdir(path.dirname(gui), { recursive: true }); await fs.mkdir(path.dirname(core), { recursive: true }); await fs.mkdir(path.join(programs, 'bin'))
  await fs.cp(payload.guiRoot, gui, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await fs.cp(payload.coreRoot, core, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  const inventories = path.join(programs, 'app/installers')
  await fs.mkdir(inventories)
  await fs.writeFile(path.join(inventories, selected.gui_id + '.json'), JSON.stringify(payload.record) + '\n')
  const executable = path.join(gui, 'Crabot.exe')
  await fs.writeFile(path.join(output, 'installer-location.json'), JSON.stringify({ schema_version: 1, candidate_only: true, release_signed: false,
    bootstrap: 'windows-first-launch', executable: path.relative(output, executable).split(path.sep).join('/'),
    programs: path.relative(output, programs), payload: path.relative(output, programs) }, null, 2) + '\n')
  if (!distribute) return
  const require = createRequire(path.join(root, 'crabot-desktop/package.json')), { build, Platform, Arch } = require('electron-builder')
  const artifacts = []
  // The pinned decoder supports BCJ, including pip's embedded ARM launchers.
  process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'
  const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
  process.env.CRABOT_WINDOWS_DECODER = await builder('app-builder-lib/out/toolsets/7zip.js').getPath7za()
  process.env.CRABOT_WINDOWS_GUI = path.relative(programs, executable).split(path.sep).join('\\')
  process.env.CRABOT_WINDOWS_DIRECTORY_HELPER = path.join(root, 'crabot-native/build/Release/crabot-install-directory.exe')
  await build({ projectDir: source, prepackaged: programs, publish: 'never', targets: Platform.WINDOWS.createTarget(['nsis'], Arch[process.arch]), config: {
    appId: 'com.crabot.desktop', productName: 'Crabot', electronVersion: '44.9.0',
    directories: { app: path.join(source, 'app'), output: path.join(output, 'distribution') }, publish: null,
    artifactName: 'Crabot-${version}-${os}-${arch}-offline-candidate.${ext}',
    win: { executableName: 'Crabot', signAndEditExecutable: false, icon: path.join(root, 'crabot-desktop/assets/app.png') },
    nsis: { oneClick: false, perMachine: false, packElevateHelper: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      script: path.join(root, 'scripts/desktop/windows-offline-installer.nsi'), installerLanguages: ['zh_CN'], deleteAppDataOnUninstall: false, runAfterFinish: false },
    afterAllArtifactBuild: async result => { artifacts.push(...result.artifactPaths); return [] },
  } })
  await fs.writeFile(path.join(output, 'distribution/artifacts.json'), JSON.stringify({ candidate_only: true, release_signed: false,
    files: artifacts.map(file => path.basename(file)) }) + '\n')
}
