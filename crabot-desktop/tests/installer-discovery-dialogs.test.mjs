// Exercise the actual installer entry with native dialogs and installation effects
// substituted. No real user directory, Electron window, Core or service is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url), ts = require('typescript')
const source = readFileSync(new URL('../src/installer-main.ts', import.meta.url), 'utf8')
const fixtureEntry = pathToFileURL(path.resolve('/fixture/installer/dist/installer-main.js')).href
const compiled = ts.transpileModule(source.replaceAll('import.meta.url', JSON.stringify(fixtureEntry)),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const home = path.resolve('/fixture/user'), existing = path.join(home, '.crabot')
const required = () => Object.assign(new Error('Existing data'), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })

async function runInstaller({ defaultError, recognized = false, selectionError } = {}) {
  const messages = [], directories = [], discovery = []
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const forbid = () => { throw Error('Unexpected installation or service effect') }
  const modules = {
    electron: {
      app: { setName() {}, setPath() {}, whenReady: async () => {}, isReady: () => true, on() {}, exit: code => finish(code) },
      shell: {},
      dialog: {
        showMessageBox: async options => {
          messages.push(options)
          if (options.title === '接管已有 Crabot') return { response: 2 }
          if (options.type === 'error') return { response: 1 }
          return { response: 0 }
        },
        showOpenDialog: async options => {
          directories.push(options)
          return selectionError && directories.length === 1
            ? { canceled: false, filePaths: [path.join(home, 'source')] }
            : { canceled: true, filePaths: [] }
        },
      },
    },
    'node:path': path, 'node:os': { homedir: () => home, tmpdir: () => '/fixture/tmp' },
    'node:fs': { mkdtempSync: prefix => prefix + 'private' },
    'node:url': { fileURLToPath, pathToFileURL: require('node:url').pathToFileURL },
    'node:child_process': { spawn: forbid }, 'node:events': require('node:events'),
    'crabot-client': require('crabot-client'),
    './installation-entries.js': { readInstallationLocator: async () => null, registerInstallationEntries: forbid, registerRetainedInstallationEntries: forbid },
    './installation-progress-window.js': { createInstallationProgressWindow: forbid },
    './retained-reinstall.js': { prepareRetainedDesktopReinstall: forbid, inspectRetainedDesktopRemoval: async () => null },
    './legacy-takeover.js': {
      installLegacyTakeover: forbid,
      discoverLegacyTakeover: async root => {
        discovery.push(root)
        if (discovery.length === 1 && defaultError) throw defaultError
        if (discovery.length > 1 && selectionError) throw selectionError
        return recognized ? { installation: { installRoot: existing, dataRoot: path.join(existing, 'data'), version: 'v2026.10.15.1' } } : null
      },
    },
  }
  const load = name => {
    if (name.endsWith('/bootstrap/scripts/lib/desktop-payload.mjs')) return {}
    if (name.endsWith('/bootstrap/scripts/lib/mode.mjs')) return { detectMode: () => 'user' }
    if (name.endsWith('/bootstrap/scripts/lib/legacy-desktop.mjs')) return { assertFreshUserInstallation: async () => { throw required() } }
    assert.ok(Object.hasOwn(modules, name), 'Unexpected module: ' + name)
    return modules[name]
  }
  vm.runInNewContext(compiled, { require: load, exports: {}, process: { platform: 'darwin', argv: [], env: {}, resourcesPath: '/fixture/resources' }, console, AbortController, Error })
  const code = await done
  return { code, messages, directories, discovery }
}

test('an existing hidden data root is visible and is the original-location picker default', { timeout: 5000 }, async () => {
  const result = await runInstaller()
  assert.equal(result.code, 2)
  assert.equal(result.directories.length, 1)
  const picker = result.directories[0]
  assert.equal(picker.defaultPath, existing)
  assert.ok(picker.properties.includes('showHiddenFiles'))
  assert.match(picker.title, /原/)
  assert.ok(result.messages.some(message => message.detail?.includes(existing) && message.detail.includes('源码')))
})

test('an unsupported original source can exit without repeatedly selecting an impossible directory', { timeout: 5000 }, async () => {
  const error = Object.assign(new Error('源码或已受管安装不在旧发行接管范围内。'), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
  const result = await runInstaller({ selectionError: error })
  const failure = result.messages.find(message => message.title === '尚未确认原安装')
  assert.ok(failure.buttons.includes('退出安装'))
  assert.match(failure.message, /源码/)
  assert.equal(result.directories.length, 1)
  assert.equal(result.code, 2)
})

test('default discovery failures retain their known reason instead of just asking for a directory', { timeout: 5000 }, async () => {
  const error = Object.assign(new Error('此历史版本尚未列入自动接管范围。'), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
  const result = await runInstaller({ defaultError: error })
  assert.ok(result.messages.some(message => message.detail?.includes(error.message)))
})

test('recognized old releases keep their explicit takeover confirmation and cancellation', { timeout: 5000 }, async () => {
  const result = await runInstaller({ recognized: true })
  assert.equal(result.directories.length, 0)
  assert.ok(result.messages.some(message => message.title === '接管已有 Crabot'))
  assert.equal(result.code, 2)
})

test('the offline installer DMG contains an installer icon without a drag-to-Applications link', async () => {
  const filename = fileURLToPath(new URL('../../scripts/desktop/package-offline-installer.mjs', import.meta.url))
  const tree = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const configurations = []
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'dmg') configurations.push(node.initializer.getText(tree))
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.equal(configurations.length, 1)
  const dmg = vm.runInNewContext('(' + configurations[0] + ')')
  assert.ok(Array.isArray(dmg.contents) && dmg.contents.length === 1, 'explicit contents must suppress the builder default Applications link')
  assert.notEqual(dmg.contents[0].type, 'link')
  assert.equal(dmg.contents[0].path, undefined)
  const builder = createRequire(require.resolve('electron-builder/package.json'))
  const { DmgTarget } = builder('dmg-builder/out/dmg.js')
  const result = await new DmgTarget({ config: { dmg: { ...dmg, icon: null } }, compression: 'normal' }, '/fixture/output')
    .computeDmgOptions('/fixture/Crabot Installer.app')
  assert.equal(result.contents.length, 1)
  assert.equal(result.backgroundColor, '#ffffff')
  assert.ok(result.contents.every(entry => entry.path !== '/Applications' && entry.type !== 'link'))
})
