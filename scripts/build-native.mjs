#!/usr/bin/env node
// Build-time only. Runtime consumers never download headers or invoke a compiler.
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { downloadProductAsset } from './lib/product-prepare.mjs'
import { runBounded } from './lib/run-bounded.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, '.desktop-build', 'native')
const version = '22.22.3'
const headers = await downloadProductAsset({
  url: `https://nodejs.org/dist/v${version}/node-v${version}-headers.tar.gz`,
  sha256: '723b896d68a288e9877ea929538494afe8b5808f6fedc3358d2ad77307d1b393',
}, cache)
const systemTar = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar'
await runBounded(systemTar, ['-xf', headers, '-C', cache])
const include = join(cache, `node-v${version}`, 'include', 'node')
const output = join(root, 'crabot-native', 'build', 'Release')
await fs.mkdir(output, { recursive: true })
const source = join(root, 'crabot-native', 'src', 'identity.cc')
const binary = join(output, 'crabot-native.node')
if (process.platform === 'win32') {
  const library = await downloadProductAsset({
    url: `https://nodejs.org/dist/v${version}/win-x64/node.lib`,
    sha256: '0d8d8bcc11daea60f5dd4da414e72ccb785718345ec8fbec52cfc7d1a2326293',
  }, cache)
  // Discover only the Microsoft compiler already installed on the build machine.
  const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  const { stdout } = await promisify(execFile)(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { timeout: 15_000 })
  const installation = stdout.trim()
  if (!installation || installation.includes('\n')) throw new Error('Microsoft C++ build tools not found')
  const script = join(cache, 'compile.cmd')
  await fs.writeFile(script, '@echo off\r\ncall "%CRABOT_NATIVE_VS%\\Common7\\Tools\\VsDevCmd.bat" -arch=x64 >nul\r\nif errorlevel 1 exit /b %errorlevel%\r\ncl.exe /nologo /LD /MT /EHsc /O2 /std:c++17 /I"%CRABOT_NATIVE_INCLUDE%" "%CRABOT_NATIVE_SOURCE%" /link "%CRABOT_NATIVE_LIBRARY%" Advapi32.lib Shell32.lib /OUT:"%CRABOT_NATIVE_BINARY%"\r\n')
  await runBounded('cmd.exe', ['/d', '/s', '/c', script], { cwd: output, env: { ...process.env,
    CRABOT_NATIVE_VS: installation, CRABOT_NATIVE_INCLUDE: include,
    CRABOT_NATIVE_SOURCE: source, CRABOT_NATIVE_LIBRARY: library, CRABOT_NATIVE_BINARY: binary,
  } })
} else {
  await runBounded(process.env.CXX || 'c++', ['-std=c++17', '-O2', '-fPIC',
    ...(process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=14.0'] : ['-shared']),
    '-I' + include, source, '-o', binary])
}
console.log('Native process identity helper built: ' + process.platform + '-' + process.arch)
